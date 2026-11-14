import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { AccessPolicy } from '../../src/actions/AccessPolicy.js';
import { RoomActionRunner } from '../../src/actions/RoomActionRunner.js';
import { RoomUnitOfWork } from '../../src/actions/RoomUnitOfWork.js';
import { SYSTEM_USER } from '../../src/domain/entities.js';
import { ActionError, StoreError } from '../../src/domain/errors.js';
import { GUEST, HOST, OUTSIDER, openTempStore, seedRoom } from './roomFixture.js';

// RoomActionRunner on a real store with a recording hub: the checks it runs before the handler,
// the response and error mapping, the rollback, and publishing only after commit.

/**
 * A hub that records what it is told, in order. `database` is the store's Database: each
 * publishAll call also records whether a transaction was still open, so a test can tell
 * publishing after commit from publishing inside the transaction.
 */
function createRecordingHub(database) {
    const calls = [];
    return {
        calls,
        publishAll(events, options) {
            const inTransaction = database.connection.inTransaction;
            calls.push({ method: 'publishAll', events, options, inTransaction });
        },
        roomMembershipChanged(roomId) {
            calls.push({ method: 'roomMembershipChanged', roomId });
        },
        roomHostChanged(roomId) {
            calls.push({ method: 'roomHostChanged', roomId });
        },
    };
}

/** A logger that keeps each error message. */
function createRecordingLogger() {
    const errors = [];
    return {
        errors,
        error(message) {
            errors.push(message);
        },
    };
}

function handlerFor(access, allowedStatuses, handle) {
    return { access, allowedStatuses, handle };
}

describe('RoomActionRunner', () => {
    let temp;
    let store;
    let seeded;
    let hub;
    let logger;
    let runner;

    beforeEach(() => {
        temp = openTempStore();
        store = temp.store;
        seeded = seedRoom(store);
        hub = createRecordingHub(store.database);
        logger = createRecordingLogger();
        runner = new RoomActionRunner({
            database: store.database,
            repositories: store.repositories,
            store,
            accessPolicy: new AccessPolicy(),
            adminEmails: new Set(['admin@example.com']),
            getHub: () => hub,
            logger,
        });
    });

    afterEach(() => {
        temp.close();
    });

    function runOnRoom(user, handler, body) {
        return runner.run(handler, { user, roomId: seeded.room.id, body });
    }

    // --- Success ---------------------------------------------------------

    test('runs the handler on a unit of work and answers the room, its players and the extra fields', () => {
        let seen = null;
        const handler = handlerFor('member', ['waiting'], (work, body) => {
            seen = { work, body };
            work.updateRoom({ max_score: body.max_score });
            return { note: 'done' };
        });

        const result = runOnRoom(GUEST, handler, { max_score: 300 });

        assert.ok(seen.work instanceof RoomUnitOfWork);
        assert.equal(seen.work.user, GUEST);
        assert.equal(seen.work.isAdmin, false);
        assert.equal(result.status, 200);
        assert.equal(result.body.room.max_score, 300);
        assert.equal(result.body.room.version, 4);
        assert.deepEqual(
            result.body.players.map((player) => player.name),
            ['Guest', 'Host'],
        );
        assert.equal(result.body.note, 'done');
        assert.deepEqual(store.getRecord('GameRoom', seeded.room.id), result.body.room);
    });

    test('publishes the events once, after commit, with the room version', () => {
        let publishedDuringHandler = null;
        const handler = handlerFor('host', null, (work) => {
            work.updateChild('Player', seeded.guest, { name: 'Renamed' });
            publishedDuringHandler = hub.calls.length;
        });

        const result = runOnRoom(HOST, handler);

        assert.equal(publishedDuringHandler, 0);
        assert.equal(hub.calls.length, 1);
        const [published] = hub.calls;
        assert.equal(published.method, 'publishAll');
        assert.equal(published.inTransaction, false);
        assert.deepEqual(published.options, { roomVersion: result.body.room.version });
        assert.deepEqual(
            published.events.map((event) => `${event.entity} ${event.type}`),
            ['Player update', 'GameRoom update'],
        );
    });

    test('an admin is checked as an admin', () => {
        const handler = handlerFor('host', null, (work) => {
            assert.equal(work.isAdmin, true);
        });

        assert.equal(runOnRoom({ email: 'admin@example.com' }, handler).status, 200);
    });

    test('with no roomId the handler creates the room and nothing is checked first', () => {
        const handler = handlerFor('host', ['playing'], (work, body) => {
            work.insertRoom({ code: 'NEWONE', status: 'waiting', host_email: OUTSIDER.email, max_score: body.max_score });
        });

        const result = runner.run(handler, { user: OUTSIDER, roomId: null, body: { max_score: 50 } });

        assert.equal(result.status, 200);
        assert.equal(result.body.room.version, 1);
        assert.deepEqual(result.body.players, []);
        assert.deepEqual(
            hub.calls[0].events.map((event) => `${event.entity} ${event.type}`),
            ['GameRoom create'],
        );
    });

    // --- Checks before the handler ---------------------------------------

    test('an unknown room, a caller without access or a wrong status answers before the handler runs', () => {
        let handlerRuns = 0;
        const handle = () => {
            handlerRuns += 1;
        };

        const missing = runner.run(handlerFor('signed_in', null, handle), { user: HOST, roomId: 'nope' });
        const notMember = runOnRoom(OUTSIDER, handlerFor('member', null, handle));
        const notHost = runOnRoom(GUEST, handlerFor('host', null, handle));
        const wrongStatus = runOnRoom(HOST, handlerFor('host', ['playing'], handle));

        assert.deepEqual([missing.status, missing.body.code], [404, 'room_not_found']);
        assert.deepEqual([notMember.status, notMember.body.code], [403, 'not_member']);
        assert.deepEqual([notHost.status, notHost.body.code], [403, 'not_host']);
        assert.deepEqual(wrongStatus.body, {
            message: 'Not allowed while the room is waiting',
            code: 'wrong_status',
            status: 'waiting',
        });
        assert.equal(wrongStatus.status, 409);
        assert.equal(handlerRuns, 0);
        assert.deepEqual(hub.calls, []);
    });

    test('a system action skips the access check but not the status check', () => {
        const allowed = runOnRoom(SYSTEM_USER, handlerFor('system', ['waiting'], () => {}));
        const refused = runOnRoom(SYSTEM_USER, handlerFor('system', ['playing'], () => {}));

        assert.equal(allowed.status, 200);
        assert.equal(refused.status, 409);
    });

    test('runAsSystem runs a host-only handler as the server, keeping its statuses', () => {
        let seen = null;
        const hostOnly = handlerFor('host', ['waiting'], (work, body) => {
            seen = { user: work.user, body };
            work.updateRoom({ max_score: body.max_score });
        });
        const playingOnly = handlerFor('host', ['playing'], () => {});

        const allowed = runner.runAsSystem(hostOnly, seeded.room.id, { max_score: 99 });
        const refused = runner.runAsSystem(playingOnly, seeded.room.id, {});

        assert.equal(allowed.status, 200);
        assert.equal(allowed.body.room.max_score, 99);
        assert.equal(seen.user, SYSTEM_USER);
        assert.deepEqual(seen.body, { max_score: 99 });
        assert.equal(refused.status, 409);
        assert.equal(refused.body.code, 'wrong_status');
    });

    // --- Failures --------------------------------------------------------

    test('an ActionError rolls every write back, publishes nothing and answers its status and body', () => {
        const handler = handlerFor('host', null, (work) => {
            work.updateChild('Player', seeded.guest, { name: 'Renamed' });
            work.flushRoom();
            throw new ActionError(400, 'bad_request', 'Nope', { field: 'name' });
        });

        const result = runOnRoom(HOST, handler);

        assert.deepEqual(result, { status: 400, body: { message: 'Nope', code: 'bad_request', field: 'name' } });
        assert.deepEqual(store.getRecord('Player', seeded.guest.id), seeded.guest);
        assert.deepEqual(store.getRecord('GameRoom', seeded.room.id), seeded.room);
        assert.deepEqual(hub.calls, []);
    });

    test('a write the database refuses answers the StoreError\'s status and rolls back', () => {
        const handler = handlerFor('host', null, (work) => {
            work.createChild('ChatMessage', { room_id: seeded.room.id, text: 'never sent' });
            // The guest already has a Player here: one player per user per room.
            work.createChild('Player', { room_id: seeded.room.id, email: GUEST.email, name: 'Again' });
        });

        const result = runOnRoom(HOST, handler);

        assert.equal(result.status, 409);
        assert.equal(result.body.code, 'conflict');
        assert.deepEqual(store.findRecords('ChatMessage', 'room_id', seeded.room.id), []);
        assert.deepEqual(hub.calls, []);
    });

    test('any other error rolls back and is rethrown', () => {
        const handler = handlerFor('host', null, (work) => {
            work.updateRoom({ max_score: 999 });
            work.flushRoom();
            throw new TypeError('bug');
        });

        assert.throws(() => runOnRoom(HOST, handler), TypeError);
        assert.equal(store.getRecord('GameRoom', seeded.room.id).max_score, 200);
        assert.deepEqual(hub.calls, []);
    });

    test('a StoreError thrown by the handler answers its status and body', () => {
        const storeError = runOnRoom(HOST, handlerFor('host', null, () => {
            throw new StoreError(400, 'invalid_record', 'Bad value');
        }));

        assert.deepEqual(storeError, { status: 400, body: { message: 'Bad value', code: 'invalid_record' } });
    });

    // --- After commit ----------------------------------------------------

    test('a join, leave or kick refreshes membership, which also covers a host change', () => {
        const handler = handlerFor('host', null, (work) => {
            work.deleteChild('Player', seeded.guest);
            work.updateRoom({ host_email: GUEST.email });
        });

        runOnRoom(HOST, handler);

        assert.deepEqual(
            hub.calls.map((call) => call.method),
            ['publishAll', 'roomMembershipChanged'],
        );
        assert.equal(hub.calls[1].roomId, seeded.room.id);
    });

    test('a host change alone tells the hub the host changed', () => {
        runOnRoom(HOST, handlerFor('host', null, (work) => {
            work.updateRoom({ host_email: GUEST.email });
        }));

        assert.deepEqual(
            hub.calls.map((call) => call.method),
            ['publishAll', 'roomHostChanged'],
        );
        assert.equal(hub.calls[1].roomId, seeded.room.id);
    });

    test('calls the hub through the object at publish time, so a replaced method is the one used', () => {
        const replaced = [];
        hub.publishAll = (events) => replaced.push(...events);

        runOnRoom(HOST, handlerFor('host', null, (work) => {
            work.updateRoom({ max_score: 250 });
        }));

        assert.deepEqual(
            replaced.map((event) => event.entity),
            ['GameRoom'],
        );
    });

    test('asks for the hub at publish time, so a hub set after the runner was built is used', () => {
        const laterHub = createRecordingHub(store.database);
        hub = laterHub;

        runOnRoom(HOST, handlerFor('host', null, (work) => {
            work.updateRoom({ max_score: 250 });
        }));

        assert.deepEqual(
            laterHub.calls.map((call) => call.method),
            ['publishAll'],
        );
    });

    test('a publish or refresh failure is logged and the committed action still answers 200', () => {
        hub.publishAll = () => {
            throw new Error('publish failed');
        };
        hub.roomMembershipChanged = () => {
            throw new Error('refresh failed');
        };

        const result = runOnRoom(HOST, handlerFor('host', null, (work) => {
            work.deleteChild('Player', seeded.guest);
        }));

        assert.equal(result.status, 200);
        assert.equal(store.getRecord('Player', seeded.guest.id), null);
        assert.deepEqual(logger.errors, [
            `Publishing events for room ${seeded.room.id} failed`,
            `Refreshing realtime state for room ${seeded.room.id} failed`,
        ]);
    });
});
