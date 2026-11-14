import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { ENTRY_STATUS_TTL_MS } from '../../../shared/realtimeProtocol.js';
import { Clock } from '../../src/domain/clock.js';
import { EntryStatusManager } from '../../src/managers/EntryStatusManager.js';
import { Lifecycle } from '../../src/managers/Lifecycle.js';
import { SubscriptionManager } from '../../src/managers/SubscriptionManager.js';
import {
    FakeSocket,
    createFakeConnections,
    createFakePlayers,
    createFakeRooms,
    createRecordingLogger,
} from './fakeSockets.js';

// EntryStatusManager over fake sockets, fixed Players and GameRooms and the real
// SubscriptionManager. Ann and Bob play in r1, which is in round 2; Ann also plays in r2. The held
// status timer runs on node:test's mock timers; the clock the tracker reads is set by hand.

const ANN = 'ann@example.com';
const BOB = 'bob@example.com';
const ADMIN = 'admin@example.com';
const START = Date.parse('2030-01-01T00:00:00.000Z');

describe('EntryStatusManager', () => {
    let time;
    let rooms;
    let players;
    let roomStore;
    let connections;
    let subscriptions;
    let logger;
    let entries;

    beforeEach(() => {
        mock.timers.enable({ apis: ['setTimeout'] });
        time = START;
        rooms = [
            { id: 'r1', status: 'playing', current_round: 2 },
            { id: 'r2', status: 'playing', current_round: 1 },
        ];
        players = [
            { id: 'ann-1', room_id: 'r1', email: ANN },
            { id: 'bob-1', room_id: 'r1', email: BOB },
            { id: 'ann-2', room_id: 'r2', email: ANN },
            { id: 'admin-1', room_id: 'r1', email: ADMIN },
        ];
        const playerStore = createFakePlayers(players);
        connections = createFakeConnections();
        subscriptions = new SubscriptionManager({
            connections,
            players: playerStore,
            isAdmin: (identity) => identity.email === ADMIN,
        });
        logger = createRecordingLogger();
        roomStore = createFakeRooms(rooms);
        entries = new EntryStatusManager({
            rooms: roomStore,
            players: playerStore,
            clock: new Clock(() => time),
            connections,
            subscriptions,
            lifecycle: new Lifecycle({ logger }),
        });
    });

    afterEach(() => {
        entries.close();
        mock.timers.reset();
    });

    /** A socket for `email` subscribed to `requested`, in the client set. */
    function subscribe(email, requested) {
        const socket = new FakeSocket(email);
        subscriptions.register(socket);
        subscriptions.apply(socket, subscriptions.resolve(socket.identity, requested));
        connections.clients.add(socket);
        return socket;
    }

    function entriesSent(socket) {
        return socket.messages().map((message) => message.entries);
    }

    describe('receive', () => {
        test('an announce is sent to the room; a repeat after the window changes nothing', () => {
            const ann = subscribe(ANN, ['r1']);
            const bob = subscribe(BOB, ['r1']);

            entries.receive(ann, { room_id: 'r1', state: 'scanning', round: 2 });
            time += 1000;
            entries.receive(ann, { room_id: 'r1', state: 'scanning', round: 2 });

            assert.deepEqual(bob.messages(), [
                { type: 'entry-status', room_id: 'r1', entries: [{ player_id: 'ann-1', state: 'scanning', round: 2 }] },
            ]);
        });

        test('ignores a state it does not know', () => {
            const ann = subscribe(ANN, ['r1']);

            entries.receive(ann, { room_id: 'r1', state: 'dancing', round: 2 });

            assert.deepEqual(ann.sent, []);
        });

        test('ignores rooms the socket did not name itself, even one its user plays in', () => {
            // Ann plays in r2 and the admin in r1, but neither socket named that room.
            const annInR1 = subscribe(ANN, ['r1']);
            const admin = subscribe(ADMIN, ['*']);
            entries.receive(annInR1, { room_id: 'r2', state: 'typing', round: 1 });
            entries.receive(admin, { room_id: 'r1', state: 'typing', round: 2 });

            // Had either been let through, it would have started its user's one-second window in
            // that room, and the same status from their socket that did name it would be dropped
            // as a repeat.
            const annInR2 = subscribe(ANN, ['r2']);
            const adminInR1 = subscribe(ADMIN, ['r1']);
            entries.receive(annInR2, { room_id: 'r2', state: 'typing', round: 1 });
            entries.receive(adminInR1, { room_id: 'r1', state: 'typing', round: 2 });

            assert.deepEqual(entriesSent(annInR2), [[{ player_id: 'ann-2', state: 'typing', round: 1 }]]);
            assert.deepEqual(entriesSent(adminInR1), [[{ player_id: 'admin-1', state: 'typing', round: 2 }]]);
        });

        test('no entry for a round that is not open or a player who already submitted', () => {
            const ann = subscribe(ANN, ['r1']);
            const bob = subscribe(BOB, ['r1']);
            players[1].has_submitted_round = true;

            entries.receive(ann, { room_id: 'r1', state: 'typing', round: 1 });
            entries.receive(bob, { room_id: 'r1', state: 'typing', round: 2 });

            assert.deepEqual(ann.sent, []);
        });

        test('a clear ends the entry; a clear with nothing announced does nothing', () => {
            const ann = subscribe(ANN, ['r1']);
            const bob = subscribe(BOB, ['r1']);
            entries.receive(bob, { room_id: 'r1', state: null, round: 2 });
            entries.receive(ann, { room_id: 'r1', state: 'typing', round: 2 });

            entries.receive(ann, { room_id: 'r1', state: null, round: 2 });

            assert.deepEqual(entriesSent(bob), [
                [{ player_id: 'ann-1', state: 'typing', round: 2 }],
                [],
            ]);
        });

        test('a change inside the window is held and applied, with its checks, as the window ends', () => {
            const ann = subscribe(ANN, ['r1']);
            const bob = subscribe(BOB, ['r1']);
            entries.receive(ann, { room_id: 'r1', state: 'scanning', round: 2 });

            time += 400;
            entries.receive(ann, { room_id: 'r1', state: 'typing', round: 2 });
            assert.equal(bob.sent.length, 1);

            time += 600;
            mock.timers.tick(600);
            assert.deepEqual(entriesSent(bob).at(-1), [{ player_id: 'ann-1', state: 'typing', round: 2 }]);
        });

        test('a held status that throws when applied is logged under the guard', () => {
            const ann = subscribe(ANN, ['r1']);
            entries.receive(ann, { room_id: 'r1', state: 'scanning', round: 2 });
            entries.receive(ann, { room_id: 'r1', state: 'typing', round: 2 });
            const error = new Error('lookup failed');
            subscriptions.findSubscribedPlayer = () => {
                throw error;
            };

            mock.timers.tick(1000);

            assert.deepEqual(logger.calls, [['error', 'Realtime held entry status failed', error]]);
        });
    });

    describe('keeping entries current', () => {
        test('reconcileRooms drops the entries the room no longer allows and tells the room', () => {
            const ann = subscribe(ANN, ['r1', 'r2']);
            const bob = subscribe(BOB, ['r1']);
            entries.receive(ann, { room_id: 'r1', state: 'typing', round: 2 });
            entries.receive(bob, { room_id: 'r1', state: 'typing', round: 2 });
            entries.receive(ann, { room_id: 'r2', state: 'typing', round: 1 });
            ann.sent.length = 0;
            players[1].has_submitted_round = true;

            entries.reconcileRooms(['r1', 'r2', 'r3']);

            assert.deepEqual(ann.messages(), [
                { type: 'entry-status', room_id: 'r1', entries: [{ player_id: 'ann-1', state: 'typing', round: 2 }] },
            ]);
        });

        test('reconcileRooms guards each room, so one failure does not stop the next', () => {
            const ann = subscribe(ANN, ['r1', 'r2']);
            entries.receive(ann, { room_id: 'r1', state: 'typing', round: 2 });
            entries.receive(ann, { room_id: 'r2', state: 'typing', round: 1 });
            ann.sent.length = 0;
            rooms[1].status = 'finished';
            const error = new Error('broken room');
            roomStore.get = (roomId) => {
                if (roomId === 'r1') {
                    throw error;
                }
                return rooms.find((room) => room.id === roomId);
            };

            entries.reconcileRooms(['r1', 'r2']);

            assert.deepEqual(logger.calls, [['error', 'Realtime entry status failed', error]]);
            assert.deepEqual(ann.messages(), [{ type: 'entry-status', room_id: 'r2', entries: [] }]);
        });

        test('sweepExpired tells each room that lost an entry', () => {
            const ann = subscribe(ANN, ['r1']);
            entries.receive(ann, { room_id: 'r1', state: 'typing', round: 2 });
            ann.sent.length = 0;

            entries.sweepExpired();
            assert.deepEqual(ann.sent, []);

            time += ENTRY_STATUS_TTL_MS.typing;
            entries.sweepExpired();
            assert.deepEqual(entriesSent(ann), [[]]);
        });

        test('sendState sends the room\'s entries only when there are any', () => {
            const ann = subscribe(ANN, ['r1']);
            entries.receive(ann, { room_id: 'r1', state: 'scanning', round: 2 });
            const late = subscribe(BOB, ['r1']);

            entries.sendState(late, 'r2');
            entries.sendState(late, 'r1');

            assert.deepEqual(late.messages(), [
                { type: 'entry-status', room_id: 'r1', entries: [{ player_id: 'ann-1', state: 'scanning', round: 2 }] },
            ]);
        });
    });
});
