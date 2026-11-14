import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { RoomUnitOfWork } from '../../src/actions/RoomUnitOfWork.js';
import { ActionError } from '../../src/domain/errors.js';
import { RoomService, randomRoomCode, requireGameMode } from '../../src/services/RoomService.js';
import { GUEST, HOST, OUTSIDER, openTempStore, seedRoom } from '../actions/roomFixture.js';

// RoomService on a real store, through a RoomUnitOfWork with no transaction around it
// (RoomActionRunner adds that). The seeded room is `waiting`, code ABCDEF, hosted by HOST, with
// the guest first in turn order.

/** Asserts that `action` throws an ActionError with this status and code. */
function assertActionError(action, status, code) {
    assert.throws(action, (error) => {
        assert.ok(error instanceof ActionError, `expected an ActionError, got ${error}`);
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        return true;
    });
}

/** Each event as "entity type", in order. */
function eventSummary(work) {
    return work.events.map((event) => `${event.entity} ${event.type}`);
}

/** A randomCode() that returns `codes` in turn, recording how many it handed out. */
function scriptedCodes(codes) {
    const source = {
        calls: 0,
        next() {
            const code = codes[source.calls];
            source.calls += 1;
            return code;
        },
    };
    return source;
}

describe('RoomService', () => {
    let temp;
    let store;
    let seeded;
    let service;

    beforeEach(() => {
        temp = openTempStore();
        store = temp.store;
        seeded = seedRoom(store);
        service = createService();
    });

    afterEach(() => {
        temp.close();
    });

    function createService(options = {}) {
        return new RoomService({
            roomRepository: store.repositories.rooms,
            playerRepository: store.repositories.players,
            ...options,
        });
    }

    function workFor(user) {
        return new RoomUnitOfWork({ repositories: store.repositories, store, user, isAdmin: false });
    }

    /** A unit of work for `user` with the seeded room loaded. */
    function loadedWork(user = HOST) {
        const work = workFor(user);
        work.loadRoom(seeded.room.id);
        return work;
    }

    function addScore(player) {
        const [score] = store.createRecords(
            'RoundScore',
            [{ room_id: seeded.room.id, player_id: player.id, round_number: 1, score: 12 }],
            HOST.email,
        );
        return score;
    }

    // --- Codes -----------------------------------------------------------

    test('randomRoomCode gives six characters from the unambiguous alphabet', () => {
        for (let index = 0; index < 50; index++) {
            assert.match(randomRoomCode(), /^[A-HJ-NP-Z2-9]{6}$/);
        }
    });

    test('generateUniqueCode skips a code an open room uses', () => {
        const codes = scriptedCodes(['ABCDEF', 'ZZZZZZ']);
        const scripted = createService({ randomCode: codes.next });

        assert.equal(scripted.generateUniqueCode(), 'ZZZZZZ');
        assert.equal(codes.calls, 2);
    });

    test('generateUniqueCode reuses the code of a closed room', () => {
        store.updateRecord('GameRoom', seeded.room.id, { status: 'closed' });
        const scripted = createService({ randomCode: scriptedCodes(['ABCDEF']).next });

        assert.equal(scripted.generateUniqueCode(), 'ABCDEF');
    });

    test('by default codes come from randomRoomCode', () => {
        assert.match(service.generateUniqueCode(), /^[A-HJ-NP-Z2-9]{6}$/);
    });

    // --- Create ----------------------------------------------------------

    test('createRoom makes a waiting room with the caller as its hosting first player', () => {
        const scripted = createService({ randomCode: scriptedCodes(['QWERTY']).next });
        const work = workFor(OUTSIDER);

        const { player } = scripted.createRoom(work, { maxScore: 150, gameMode: 'brutal', name: 'Olive' });
        work.finish();

        const room = store.getRecord('GameRoom', work.room.id);
        assert.equal(room.code, 'QWERTY');
        assert.equal(room.status, 'waiting');
        assert.equal(room.host_email, OUTSIDER.email);
        assert.equal(room.host_player_id, player.id);
        assert.equal(room.max_score, 150);
        assert.equal(room.game_mode, 'brutal');
        assert.equal(room.current_round, 1);
        assert.equal(room.game_number, 1);
        assert.equal(room.is_edit_mode, false);
        assert.equal(room.version, 1);

        assert.equal(player.room_id, room.id);
        assert.equal(player.email, OUTSIDER.email);
        assert.equal(player.name, 'Olive');
        assert.equal(player.is_host, true);
        assert.equal(player.turn_order, 0);
        assert.equal(player.total_score, 0);
        assert.equal(player.games_won, 0);
        assert.deepEqual(eventSummary(work), ['Player create', 'GameRoom create']);
    });

    test('createRoom names the host from full_name when no name was asked for', () => {
        const work = workFor({ email: 'olive@example.com', full_name: '  Olive Oyl  ' });

        const { player } = service.createRoom(work, { maxScore: 200, gameMode: 'classic', name: null });

        assert.equal(player.name, 'Olive Oyl');
    });

    test('createRoom falls back to the email local part when the user has no name', () => {
        const work = workFor({ email: 'olive@example.com', full_name: '   ' });

        const { player } = service.createRoom(work, { maxScore: 200, gameMode: 'classic', name: null });

        assert.equal(player.name, 'olive');
    });

    // --- Game mode -------------------------------------------------------

    test('requireGameMode accepts a mode and rejects anything else with a 400', () => {
        assert.equal(requireGameMode('vengeance'), 'vengeance');
        assertActionError(() => requireGameMode('chess'), 400, 'bad_request');
        assertActionError(() => requireGameMode(undefined), 400, 'bad_request');
    });

    test('setGameMode switches the mode', () => {
        const work = loadedWork();

        service.setGameMode(work, 'vengeance');

        assert.equal(work.room.game_mode, 'vengeance');
    });

    test('setGameMode to the current mode changes nothing, even once locked', () => {
        addScore(seeded.host);
        const work = loadedWork();

        service.setGameMode(work, 'classic');
        work.finish();

        assert.deepEqual(work.events, []);
    });

    test('setGameMode is locked once someone has scored', () => {
        addScore(seeded.guest);
        const work = loadedWork();

        assertActionError(() => service.setGameMode(work, 'brutal'), 409, 'mode_locked');
    });

    test('setGameMode is locked in a finished game', () => {
        store.updateRecord('GameRoom', seeded.room.id, { status: 'finished' });
        const work = loadedWork();

        assertActionError(() => service.setGameMode(work, 'brutal'), 409, 'mode_locked');
    });

    // --- Start -----------------------------------------------------------

    test('resetPlayersForNewGame deletes the scores and zeroes every player', () => {
        const score = addScore(seeded.host);
        store.updateRecord('Player', seeded.host.id, { total_score: 40, current_round_score: 12, has_submitted_round: true });
        const work = loadedWork();

        service.resetPlayersForNewGame(work);

        assert.equal(store.getRecord('RoundScore', score.id), null);
        const host = store.getRecord('Player', seeded.host.id);
        assert.equal(host.total_score, 0);
        assert.equal(host.current_round_score, 0);
        assert.equal(host.has_submitted_round, false);
    });

    test('start resets the players, then plays round 1 with the first in turn order to deal', () => {
        addScore(seeded.host);
        store.updateRecord('GameRoom', seeded.room.id, { current_round: 4, winner_player_id: seeded.host.id });
        const work = loadedWork();

        service.start(work);
        work.finish();

        const room = store.getRecord('GameRoom', seeded.room.id);
        assert.equal(room.status, 'playing');
        assert.equal(room.current_round, 1);
        assert.equal(room.current_turn_player_id, seeded.guest.id);
        assert.equal(room.winner_player_id, null);
        assert.equal(room.turn_passed_round, null);
        assert.equal(room.finish_reason, null);
        // The children's events go out before the room's `playing` update (bug 4.7).
        assert.equal(eventSummary(work).at(-1), 'GameRoom update');
        assert.equal(eventSummary(work)[0], 'RoundScore delete');
    });

    test('start refuses a room with no players', () => {
        store.deleteRecord('Player', seeded.host.id);
        store.deleteRecord('Player', seeded.guest.id);
        const work = loadedWork();

        assertActionError(() => service.start(work), 400, 'bad_request');
    });

    // --- Close and delete ------------------------------------------------

    test('close marks the room closed', () => {
        const work = loadedWork();

        service.close(work);

        assert.equal(work.room.status, 'closed');
    });

    test('deleteRoom publishes the room as closed, then deletes its children and itself', () => {
        const [message] = store.createRecords('ChatMessage', [{ room_id: seeded.room.id, text: 'hi' }], HOST.email);
        const score = addScore(seeded.guest);
        const work = loadedWork();

        service.deleteRoom(work);
        work.finish();

        assert.deepEqual(eventSummary(work), [
            'GameRoom update',
            'ChatMessage delete',
            'RoundScore delete',
            'Player delete',
            'Player delete',
            'GameRoom delete',
        ]);
        assert.equal(work.events[0].record.status, 'closed');
        assert.equal(store.getRecord('GameRoom', seeded.room.id), null);
        assert.equal(store.getRecord('ChatMessage', message.id), null);
        assert.equal(store.getRecord('RoundScore', score.id), null);
        assert.equal(store.getRecord('Player', seeded.host.id), null);
    });

    // --- Lookup by code --------------------------------------------------

    test('lookupByCode finds the room by a lowercase, padded code, without email fields', () => {
        const found = service.lookupByCode(OUTSIDER.email, '  abcdef ');

        assert.equal(found.room.id, seeded.room.id);
        assert.equal(found.room.code, 'ABCDEF');
        assert.equal('host_email' in found.room, false);
        assert.equal('created_by' in found.room, false);
        assert.equal(found.my_player, null);
    });

    test('lookupByCode lists the players\' public fields in turn order', () => {
        const found = service.lookupByCode(OUTSIDER.email, 'ABCDEF');

        assert.deepEqual(found.players, [
            { id: seeded.guest.id, name: 'Guest', turn_order: 0, is_host: false },
            { id: seeded.host.id, name: 'Host', turn_order: 1, is_host: true },
        ]);
    });

    test('lookupByCode returns the caller\'s own Player in full', () => {
        const found = service.lookupByCode(GUEST.email, 'ABCDEF');

        assert.deepEqual(found.my_player, store.getRecord('Player', seeded.guest.id));
    });

    test('lookupByCode skips closed rooms and picks the newest open one', () => {
        store.updateRecord('GameRoom', seeded.room.id, { status: 'closed' });
        const [reopened] = store.createRecords(
            'GameRoom',
            [{ code: 'ABCDEF', status: 'waiting', host_email: HOST.email, max_score: 200 }],
            HOST.email,
        );

        const found = service.lookupByCode(OUTSIDER.email, 'ABCDEF');

        assert.equal(found.room.id, reopened.id);
        assert.deepEqual(found.players, []);
    });

    test('lookupByCode is a 404 when no open room has the code', () => {
        assertActionError(() => service.lookupByCode(HOST.email, 'NOPE22'), 404, 'room_not_found');

        store.updateRecord('GameRoom', seeded.room.id, { status: 'closed' });
        assertActionError(() => service.lookupByCode(HOST.email, 'ABCDEF'), 404, 'room_not_found');
    });
});
