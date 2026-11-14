import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { RoomUnitOfWork } from '../../src/actions/RoomUnitOfWork.js';
import { ActionError } from '../../src/domain/errors.js';
import {
    PlayerService,
    isHostPlayer,
    isTurnPassed,
    newPlayerFields,
    nextPlayerAfter,
} from '../../src/services/PlayerService.js';
import { RoundService } from '../../src/services/RoundService.js';
import { GUEST, HOST, OUTSIDER, openTempStore, seedRoom } from '../actions/roomFixture.js';

// PlayerService on a real store through a RoomUnitOfWork. The round check and the totals rule it
// calls are recording stubs, so each test sees exactly which round checks and recomputes it asked
// for. Clearing edit mode is RoundService's real one, since the tests check its effect.

/** Asserts that `action` throws an ActionError with this status and code. */
function assertActionError(action, status, code) {
    assert.throws(action, (error) => {
        assert.ok(error instanceof ActionError, `expected an ActionError, got ${error}`);
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        return true;
    });
}

/** A RoundService whose round check only records the room it ran on. */
class RecordingRoundService extends RoundService {
    constructor(calls) {
        super();
        this.calls = calls;
    }

    runRoundCheck(work) {
        this.calls.roundChecks.push(work.room.id);
    }
}

/** A PlayerService whose round check and totals rule record their calls in `calls`. */
function createRecordingService() {
    const calls = { roundChecks: [], attackRecomputes: [] };
    const service = new PlayerService({
        roundService: new RecordingRoundService(calls),
        totalsService: {
            recomputeAttackTarget(work, targetId) {
                calls.attackRecomputes.push(targetId);
            },
        },
    });
    return { service, calls };
}

describe('PlayerService helpers', () => {
    const players = [
        { id: 'a', turn_order: 0 },
        { id: 'b', turn_order: 1 },
        { id: 'c', turn_order: 2 },
    ];

    test('nextPlayerAfter takes the next by turn order and wraps around', () => {
        assert.equal(nextPlayerAfter(players, players[0]).id, 'b');
        assert.equal(nextPlayerAfter(players, players[2]).id, 'a');
    });

    test('nextPlayerAfter is null for the only player', () => {
        assert.equal(nextPlayerAfter([players[0]], players[0]), null);
    });

    test('isTurnPassed compares the marker with the current round', () => {
        assert.equal(isTurnPassed({ turn_passed_round: 3, current_round: 3 }), true);
        assert.equal(isTurnPassed({ turn_passed_round: 2, current_round: 3 }), false);
        assert.equal(isTurnPassed({ turn_passed_round: null, current_round: 3 }), false);
    });

    test('isHostPlayer matches the host_player_id, or the email for older rooms', () => {
        const player = { id: 'p1', email: 'a@example.com' };
        assert.equal(isHostPlayer({ host_player_id: 'p1', host_email: 'x@example.com' }, player), true);
        assert.equal(isHostPlayer({ host_player_id: null, host_email: 'a@example.com' }, player), true);
        assert.equal(isHostPlayer({ host_player_id: 'p2', host_email: 'x@example.com' }, player), false);
    });

    test('newPlayerFields starts every game field at zero', () => {
        assert.deepEqual(newPlayerFields({ id: 'room1' }, 'a@example.com', 'Ann', 4, true), {
            room_id: 'room1',
            email: 'a@example.com',
            name: 'Ann',
            is_host: true,
            turn_order: 4,
            total_score: 0,
            current_round_score: 0,
            has_submitted_round: false,
            games_won: 0,
            last_seen: null,
        });
    });
});

describe('PlayerService', () => {
    let temp;
    let store;
    let seeded;
    let service;
    let calls;

    beforeEach(() => {
        temp = openTempStore();
        store = temp.store;
        seeded = seedRoom(store);
        ({ service, calls } = createRecordingService());
    });

    afterEach(() => {
        temp.close();
    });

    /** A unit of work for `user` with `roomId` (the seeded room by default) loaded. */
    function workFor(user, roomId = seeded.room.id) {
        const work = new RoomUnitOfWork({ repositories: store.repositories, store, user, isAdmin: false });
        work.loadRoom(roomId);
        return work;
    }

    function getPlayer(id) {
        return store.getRecord('Player', id);
    }

    /** Sets fields on the seeded room before a test's unit of work loads it. */
    function updateSeededRoom(fields) {
        store.updateRecord('GameRoom', seeded.room.id, fields);
    }

    /** Adds a third player, last in turn order. */
    function addOutsiderPlayer() {
        const [player] = store.createRecords(
            'Player',
            [{ room_id: seeded.room.id, email: OUTSIDER.email, name: 'Third', turn_order: 2, is_host: false }],
            OUTSIDER.email,
        );
        return player;
    }

    // --- join ----------------------------------------------------------

    describe('join', () => {
        test('seats a new caller after the last player in turn order', () => {
            const work = workFor(OUTSIDER);
            const result = service.join(work, 'Olive');

            assert.equal(result.already_joined, false);
            assert.equal(result.player.name, 'Olive');
            assert.equal(result.player.email, OUTSIDER.email);
            assert.equal(result.player.turn_order, 2);
            assert.equal(result.player.is_host, false);
            assert.equal(getPlayer(result.player.id).room_id, seeded.room.id);
        });

        test('seats the first player of an empty room at turn order 0', () => {
            const [emptyRoom] = store.createRecords('GameRoom', [{ code: 'EMPTY1', status: 'waiting' }], HOST.email);
            const work = workFor(OUTSIDER, emptyRoom.id);

            const result = service.join(work, 'Olive');

            assert.equal(result.player.turn_order, 0);
        });

        test('gives back the existing Player for a caller already seated, even with no name', () => {
            const work = workFor(GUEST);
            const result = service.join(work, null);

            assert.equal(result.already_joined, true);
            assert.equal(result.player.id, seeded.guest.id);
            assert.equal(work.events.length, 0);
        });

        test('a new caller without a name is a 400', () => {
            const work = workFor(OUTSIDER);
            assertActionError(() => service.join(work, null), 400, 'bad_request');
        });
    });

    // --- leave ---------------------------------------------------------

    describe('leave', () => {
        test('removes the caller and runs the round check', () => {
            const work = workFor(GUEST);
            service.leave(work);

            assert.equal(getPlayer(seeded.guest.id), null);
            assert.deepEqual(calls.roundChecks, [seeded.room.id]);
        });

        test('a caller who is not in the room gets player_not_found', () => {
            const work = workFor(OUTSIDER);
            assertActionError(() => service.leave(work), 404, 'player_not_found');
        });

        test('a member of a closed room gets wrong_status', () => {
            updateSeededRoom({ status: 'closed' });
            const work = workFor(GUEST);

            assertActionError(() => service.leave(work), 409, 'wrong_status');
            assert.ok(getPlayer(seeded.guest.id));
        });
    });

    // --- kick ----------------------------------------------------------

    describe('kick', () => {
        test('removes the player and runs the round check', () => {
            const work = workFor(HOST);
            service.kick(work, seeded.guest.id);

            assert.equal(getPlayer(seeded.guest.id), null);
            assert.deepEqual(calls.roundChecks, [seeded.room.id]);
        });

        test('kicking yourself is a 400', () => {
            const work = workFor(HOST);
            assertActionError(() => service.kick(work, seeded.host.id), 400, 'bad_request');
        });

        test('an unknown player is a 404', () => {
            const work = workFor(HOST);
            assertActionError(() => service.kick(work, 'missing'), 404, 'player_not_found');
        });
    });

    // --- makeHost ------------------------------------------------------

    describe('makeHost', () => {
        test('moves the host role, ends edit mode and runs the round check', () => {
            updateSeededRoom({ host_player_id: seeded.host.id, is_edit_mode: true, edit_mode_by: seeded.host.id });
            const work = workFor(HOST);

            service.makeHost(work, seeded.guest.id);

            assert.equal(work.room.host_email, GUEST.email);
            assert.equal(work.room.host_player_id, seeded.guest.id);
            assert.equal(work.room.is_edit_mode, false);
            assert.equal(work.room.edit_mode_by, null);
            assert.equal(getPlayer(seeded.guest.id).is_host, true);
            assert.equal(getPlayer(seeded.host.id).is_host, false);
            assert.deepEqual(calls.roundChecks, [seeded.room.id]);
        });

        test('changes nothing when the player already hosts', () => {
            updateSeededRoom({ host_player_id: seeded.host.id });
            const work = workFor(HOST);

            service.makeHost(work, seeded.host.id);

            assert.equal(work.events.length, 0);
            assert.deepEqual(calls.roundChecks, []);
        });

        test('repairs is_host when host_player_id already names the player', () => {
            store.updateRecord('Player', seeded.host.id, { is_host: false });
            updateSeededRoom({ host_player_id: seeded.host.id });
            const work = workFor(HOST);

            service.makeHost(work, seeded.host.id);

            assert.equal(getPlayer(seeded.host.id).is_host, true);
        });
    });

    // --- reorder -------------------------------------------------------

    describe('reorder', () => {
        test('sets turn_order to each id’s position in the list', () => {
            const work = workFor(HOST);
            service.reorder(work, [seeded.host.id, seeded.guest.id]);

            assert.equal(getPlayer(seeded.host.id).turn_order, 0);
            assert.equal(getPlayer(seeded.guest.id).turn_order, 1);
        });

        const badLists = {
            'a duplicate': (ids) => [ids.host, ids.host],
            'a missing player': (ids) => [ids.host],
            'an extra id': (ids) => [ids.host, ids.guest, 'other'],
            'an unknown id': (ids) => [ids.host, 'other'],
        };
        for (const [label, buildList] of Object.entries(badLists)) {
            test(`a list with ${label} is a 400`, () => {
                const work = workFor(HOST);
                const playerIds = buildList({ host: seeded.host.id, guest: seeded.guest.id });

                assertActionError(() => service.reorder(work, playerIds), 400, 'bad_request');
            });
        }
    });

    // --- removePlayer ----------------------------------------------------

    describe('removePlayer', () => {
        test('deletes the player’s scores and recomputes the players they attacked', () => {
            const third = addOutsiderPlayer();
            store.createRecords(
                'RoundScore',
                [
                    { room_id: seeded.room.id, player_id: seeded.guest.id, flip7_attack_player_id: third.id },
                    { room_id: seeded.room.id, player_id: seeded.guest.id, flip7_attack_player_id: null },
                    { room_id: seeded.room.id, player_id: seeded.host.id, flip7_attack_player_id: seeded.guest.id },
                ],
                HOST.email,
            );
            const work = workFor(HOST);

            service.removePlayer(work, seeded.guest);

            const remainingScores = store.findRecords('RoundScore', 'room_id', seeded.room.id);
            assert.deepEqual(
                remainingScores.map((score) => score.player_id),
                [seeded.host.id],
            );
            assert.deepEqual(calls.attackRecomputes, [third.id, null]);
        });

        test('the last player leaving closes the room', () => {
            const work = workFor(HOST);
            service.removePlayer(work, seeded.guest);
            service.removePlayer(work, seeded.host);

            assert.equal(work.room.status, 'closed');
        });

        test('a departing winner is no longer named', () => {
            updateSeededRoom({ winner_player_id: seeded.guest.id });
            const work = workFor(HOST);

            service.removePlayer(work, seeded.guest);

            assert.equal(work.room.winner_player_id, null);
        });

        test('a non-host who had edit mode on turns it off', () => {
            updateSeededRoom({ status: 'playing', is_edit_mode: true, edit_mode_by: seeded.guest.id });
            const work = workFor(HOST);

            service.removePlayer(work, seeded.guest);

            assert.equal(work.room.is_edit_mode, false);
            assert.equal(work.room.host_email, HOST.email);
        });

        test('edit mode someone else turned on stays on', () => {
            updateSeededRoom({ status: 'playing', is_edit_mode: true, edit_mode_by: seeded.host.id });
            const work = workFor(HOST);

            service.removePlayer(work, seeded.guest);

            assert.equal(work.room.is_edit_mode, true);
        });

        test('a departing host hands hosting to the next player by turn order', () => {
            const third = addOutsiderPlayer();
            const work = workFor(HOST);

            service.removePlayer(work, seeded.host);

            // The host sat at turn order 1, so the next is the third player (2), not the guest (0).
            assert.equal(work.room.host_player_id, third.id);
            assert.equal(work.room.host_email, OUTSIDER.email);
        });

        describe('when the dealer leaves', () => {
            /** The seeded room in `fields`, with the guest dealing round 2. */
            function dealerRoom(fields) {
                updateSeededRoom({ current_round: 2, current_turn_player_id: seeded.guest.id, ...fields });
            }

            function markSubmitted(player, hasSubmitted) {
                store.updateRecord('Player', player.id, { has_submitted_round: hasSubmitted });
            }

            test('mid-round, the next player deals the rest of the round', () => {
                dealerRoom({ status: 'playing' });
                markSubmitted(seeded.host, false);
                const work = workFor(HOST);

                service.removePlayer(work, seeded.guest);

                assert.equal(work.room.current_turn_player_id, seeded.host.id);
                assert.equal(work.room.turn_passed_round, null);
            });

            test('after a complete round, the turn is marked as passed', () => {
                dealerRoom({ status: 'playing' });
                markSubmitted(seeded.host, true);
                const work = workFor(HOST);

                service.removePlayer(work, seeded.guest);

                assert.equal(work.room.current_turn_player_id, seeded.host.id);
                assert.equal(work.room.turn_passed_round, 2);
            });

            test('a max_score finish counts as complete even with players unmarked', () => {
                dealerRoom({ status: 'finished', finish_reason: 'max_score' });
                markSubmitted(seeded.host, false);
                const work = workFor(HOST);

                service.removePlayer(work, seeded.guest);

                assert.equal(work.room.turn_passed_round, 2);
            });

            test('an ended game with players unmarked is not complete', () => {
                dealerRoom({ status: 'finished', finish_reason: 'ended' });
                markSubmitted(seeded.host, false);
                const work = workFor(HOST);

                service.removePlayer(work, seeded.guest);

                assert.equal(work.room.turn_passed_round, null);
            });

            test('a waiting room has no round to complete', () => {
                dealerRoom({ status: 'waiting' });
                markSubmitted(seeded.host, true);
                const work = workFor(HOST);

                service.removePlayer(work, seeded.guest);

                assert.equal(work.room.current_turn_player_id, seeded.host.id);
                assert.equal(work.room.turn_passed_round, null);
            });

            test('a turn already passed this round stays passed', () => {
                dealerRoom({ status: 'playing', turn_passed_round: 2 });
                markSubmitted(seeded.host, false);
                const work = workFor(HOST);

                service.removePlayer(work, seeded.guest);

                assert.equal(work.room.turn_passed_round, 2);
            });
        });
    });
});
