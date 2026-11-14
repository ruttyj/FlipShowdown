import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { RoomUnitOfWork } from '../../src/actions/RoomUnitOfWork.js';
import { ActionError } from '../../src/domain/errors.js';
import { GUEST, HOST, OUTSIDER, openTempStore, seedRoom } from './roomFixture.js';

// RoomUnitOfWork on a real store: the writes it makes, the events it queues and how it merges
// them, and the room's version bump. Each test runs outside a transaction, which is fine for a
// unit of work on its own: RoomActionRunner is what wraps it in one.

/** Asserts that `action` throws an ActionError with this status and code; returns the error. */
function assertActionError(action, status, code) {
    let thrown = null;
    assert.throws(action, (error) => {
        assert.ok(error instanceof ActionError, `expected an ActionError, got ${error}`);
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        thrown = error;
        return true;
    });
    return thrown;
}

/** Each event as "entity type", in order. */
function eventSummary(work) {
    return work.events.map((event) => `${event.entity} ${event.type}`);
}

describe('RoomUnitOfWork', () => {
    let temp;
    let store;
    let seeded;

    beforeEach(() => {
        temp = openTempStore();
        store = temp.store;
        seeded = seedRoom(store);
    });

    afterEach(() => {
        temp.close();
    });

    function workFor(user, { isAdmin = false } = {}) {
        return new RoomUnitOfWork({ repositories: store.repositories, store, user, isAdmin });
    }

    /** A unit of work for HOST with the seeded room loaded. */
    function loadedWork(user = HOST) {
        const work = workFor(user);
        work.loadRoom(seeded.room.id);
        return work;
    }

    // --- Loading and reading ---------------------------------------------

    test('keeps the caller, the admin flag and the store it was given', () => {
        const work = workFor(GUEST, { isAdmin: true });

        assert.equal(work.user, GUEST);
        assert.equal(work.isAdmin, true);
        assert.equal(work.store, store);
        assert.equal(work.room, null);
        assert.deepEqual(work.events, []);
    });

    test('loadRoom makes the room the action\'s room, or answers room_not_found', () => {
        const work = loadedWork();
        assert.deepEqual(work.room, seeded.room);
        assert.equal(work.roomVersion, 3);

        assertActionError(() => workFor(HOST).loadRoom('no-such-room'), 404, 'room_not_found');
    });

    test('listPlayers sorts by turn order; findCallerPlayer finds the caller\'s own Player', () => {
        const work = loadedWork();

        assert.deepEqual(
            work.listPlayers().map((player) => player.name),
            ['Guest', 'Host'],
        );
        assert.equal(work.findCallerPlayer().id, seeded.host.id);
        assert.equal(loadedWork(OUTSIDER).findCallerPlayer(), null);
    });

    test('getRoomPlayer finds a player of this room only', () => {
        const other = seedRoom(store, { code: 'ZZZZZZ' });
        const work = loadedWork();

        assert.deepEqual(work.getRoomPlayer(seeded.guest.id), seeded.guest);
        assertActionError(() => work.getRoomPlayer(other.guest.id), 404, 'player_not_found');
        assertActionError(() => work.getRoomPlayer('no-such-player'), 404, 'player_not_found');
    });

    test('a child entity it does not know is refused instead of written elsewhere', () => {
        const work = loadedWork();

        assert.throws(() => work.createChild('GameRoom', { code: 'NOPE' }), /Not a room child entity: GameRoom/);
        assert.throws(() => work.listRoomChildren('Note'), /Not a room child entity: Note/);
        // Refused even when no field would change, so the check can't depend on the data.
        assert.throws(() => work.updateChild('GameRoom', work.room, { status: work.room.status }), /Not a room child entity: GameRoom/);
        assert.throws(() => work.updateChild('GameRoom', work.room, { status: 'closed' }), /Not a room child entity: GameRoom/);
        assert.throws(() => work.deleteChild('GameRoom', work.room), /Not a room child entity: GameRoom/);
        assert.deepEqual(work.events, []);
    });

    // --- Child writes and their events -----------------------------------

    test('createChild writes as the caller and queues a create with the stored record', () => {
        const work = loadedWork();

        const message = work.createChild('ChatMessage', { room_id: seeded.room.id, text: 'hi' });

        assert.equal(message.created_by, HOST.email);
        assert.deepEqual(store.getRecord('ChatMessage', message.id), message);
        assert.deepEqual(work.events, [{ entity: 'ChatMessage', type: 'create', record: message }]);
        assert.deepEqual(work.listRoomChildren('ChatMessage'), [message]);
    });

    test('updateChild writes only changed fields, and nothing when none changed', () => {
        const work = loadedWork();

        const unchanged = work.updateChild('Player', seeded.guest, { name: 'Guest' });
        assert.equal(unchanged, seeded.guest);
        assert.deepEqual(work.events, []);

        const renamed = work.updateChild('Player', seeded.guest, { name: 'Renamed', turn_order: 0 });
        assert.equal(renamed.name, 'Renamed');
        assert.deepEqual(store.getRecord('Player', seeded.guest.id), renamed);
        assert.deepEqual(work.events, [{ entity: 'Player', type: 'update', record: renamed }]);
    });

    test('repeated updates collapse into one event with the latest record, in the first one\'s place', () => {
        const work = loadedWork();

        work.updateChild('Player', seeded.guest, { name: 'One' });
        work.updateChild('Player', seeded.host, { name: 'Boss' });
        const latest = work.updateChild('Player', store.getRecord('Player', seeded.guest.id), { name: 'Two' });

        assert.deepEqual(eventSummary(work), ['Player update', 'Player update']);
        assert.deepEqual(work.events[0].record, latest);
    });

    test('an update after a create keeps the create, with the updated record', () => {
        const work = loadedWork();

        const message = work.createChild('ChatMessage', { room_id: seeded.room.id, text: 'hi' });
        const edited = work.updateChild('ChatMessage', message, { text: 'hello' });

        assert.deepEqual(work.events, [{ entity: 'ChatMessage', type: 'create', record: edited }]);
    });

    test('a record created and deleted in one action publishes nothing', () => {
        const work = loadedWork();

        const message = work.createChild('ChatMessage', { room_id: seeded.room.id, text: 'hi' });
        work.deleteChild('ChatMessage', message);

        assert.deepEqual(work.events, []);
        assert.equal(store.getRecord('ChatMessage', message.id), null);
    });

    test('a delete replaces an earlier update and moves to the end; a second delete queues nothing', () => {
        const work = loadedWork();

        const renamed = work.updateChild('Player', seeded.guest, { name: 'Renamed' });
        work.updateChild('Player', seeded.host, { name: 'Boss' });
        work.deleteChild('Player', renamed);
        work.deleteChild('Player', renamed);

        assert.deepEqual(eventSummary(work), ['Player update', 'Player delete']);
        assert.deepEqual(work.events[1].record, renamed);
    });

    // --- The room record -------------------------------------------------

    test('updateRoom stages changes; finish writes them with one version bump and queues the room last', () => {
        const work = loadedWork();

        work.updateRoom({ status: 'playing' });
        assert.equal(work.room.status, 'playing');
        assert.equal(store.getRecord('GameRoom', seeded.room.id).status, 'waiting');

        work.updateChild('Player', seeded.guest, { name: 'Renamed' });
        work.updateRoom({ current_round: 2 });
        work.finish();

        const stored = store.getRecord('GameRoom', seeded.room.id);
        assert.equal(stored.status, 'playing');
        assert.equal(stored.current_round, 2);
        assert.equal(stored.version, 4);
        assert.notEqual(stored.last_activity_date, null);
        assert.deepEqual(work.room, stored);
        assert.equal(work.roomVersion, 4);
        assert.deepEqual(eventSummary(work), ['Player update', 'GameRoom update']);
    });

    test('updateRoom with nothing different changes nothing, so finish writes nothing', () => {
        const work = loadedWork();

        work.updateRoom({ status: 'waiting' });
        work.finish();

        assert.deepEqual(store.getRecord('GameRoom', seeded.room.id), seeded.room);
        assert.deepEqual(work.events, []);
    });

    test('a child write alone still bumps the room version once', () => {
        const work = loadedWork();

        work.createChild('ChatMessage', { room_id: seeded.room.id, text: 'hi' });
        work.finish();

        assert.equal(store.getRecord('GameRoom', seeded.room.id).version, 4);
    });

    test('flushing twice bumps the version once and keeps one room event', () => {
        const work = loadedWork();

        work.updateRoom({ status: 'playing' });
        work.flushRoom();
        work.updateRoom({ current_round: 2 });
        work.flushRoom();

        assert.equal(work.room.version, 4);
        assert.equal(work.room.current_round, 2);
        assert.deepEqual(work.events, [{ entity: 'GameRoom', type: 'update', record: work.room }]);
    });

    test('deleting the room after a flush publishes the closed room first and the delete last', () => {
        const work = loadedWork();

        work.updateRoom({ status: 'closed' });
        work.flushRoom();
        for (const player of work.listRoomChildren('Player')) {
            work.deleteChild('Player', player);
        }
        work.deleteRoomRecord();
        work.finish();

        assert.deepEqual(eventSummary(work), ['GameRoom update', 'Player delete', 'Player delete', 'GameRoom delete']);
        assert.equal(work.events[0].record.status, 'closed');
        assert.equal(work.events[3].record.version, 4);
        assert.equal(store.getRecord('GameRoom', seeded.room.id), null);
    });

    test('insertRoom creates the room at version 0 and finish publishes it as a create at version 1', () => {
        const work = workFor(GUEST);

        const room = work.insertRoom({ code: 'NEWONE', status: 'waiting', host_email: GUEST.email, max_score: 100 });
        assert.equal(room.version, 0);
        assert.equal(room.created_by, GUEST.email);
        work.createChild('Player', { room_id: room.id, email: GUEST.email, name: 'Guest', turn_order: 0 });
        work.finish();

        assert.deepEqual(eventSummary(work), ['Player create', 'GameRoom create']);
        assert.equal(work.room.version, 1);
        assert.equal(work.hasHostChange(), false);
    });

    // --- Status and what changed -----------------------------------------

    test('requireStatus allows any status for null and the listed ones, else answers wrong_status', () => {
        const work = loadedWork();

        work.requireStatus(null);
        work.requireStatus(['waiting', 'playing']);
        const error = assertActionError(() => work.requireStatus(['playing']), 409, 'wrong_status');
        assert.deepEqual(error.toBody(), {
            message: 'Not allowed while the room is waiting',
            code: 'wrong_status',
            status: 'waiting',
        });
    });

    test('a membership change is a Player created or deleted, not updated', () => {
        const updated = loadedWork();
        updated.updateChild('Player', seeded.guest, { name: 'Renamed' });
        assert.equal(updated.hasMembershipChange(), false);

        const left = loadedWork();
        left.deleteChild('Player', seeded.guest);
        assert.equal(left.hasMembershipChange(), true);

        const joined = loadedWork(OUTSIDER);
        joined.createChild('Player', { room_id: seeded.room.id, email: OUTSIDER.email, name: 'New', turn_order: 2 });
        assert.equal(joined.hasMembershipChange(), true);
    });

    test('a host change is a new host_email on a room that existed before the action', () => {
        const work = loadedWork();
        assert.equal(work.hasHostChange(), false);

        work.updateRoom({ host_email: GUEST.email });
        assert.equal(work.hasHostChange(), true);
    });
});
