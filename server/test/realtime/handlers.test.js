import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { EntryStatusHandler } from '../../src/realtime/handlers/EntryStatusHandler.js';
import { HelloHandler } from '../../src/realtime/handlers/HelloHandler.js';
import { createSocketHandlers } from '../../src/realtime/handlers/index.js';
import { RoomsHandler } from '../../src/realtime/handlers/RoomsHandler.js';
import { VoteHoldHandler } from '../../src/realtime/handlers/VoteHoldHandler.js';
import { VoteReleaseHandler } from '../../src/realtime/handlers/VoteReleaseHandler.js';
import { createRecordingParts } from './recordingParts.js';

// The client message handlers over recorded stand-ins for the managers: what each calls, in which
// order. realtime.test and votesRealtime.test cover the same messages end to end.

const IDENTITY = { email: 'ann@example.com' };

describe('socket handlers', () => {
    let calls;
    let results;
    let parts;
    let socket;

    beforeEach(() => {
        ({ calls, results, parts } = createRecordingParts());
        socket = { identity: IDENTITY };
    });

    /** The types of the messages sent, in order. */
    function sentTypes() {
        const types = [];
        for (const call of calls) {
            if (call[0] === 'connections.send') {
                types.push(call[2].type);
            }
        }
        return types;
    }

    function hasReplayed() {
        return calls.some((call) => call[0] === 'publisher.replay');
    }

    test('createSocketHandlers has one handler per client message type but ping', () => {
        const types = createSocketHandlers(parts).map((handler) => handler.type);

        assert.deepEqual(types, ['hello', 'rooms', 'vote-hold', 'vote-release', 'entry-status']);
    });

    describe('hello', () => {
        const subscription = { rooms: new Set(['r1', 'r2']), allRooms: false };
        const applied = { added: ['r2'], removed: ['r0'], affected: new Set(['r0', 'r1', 'r2']) };

        beforeEach(() => {
            results['subscriptions.resolve'] = subscription;
            results['subscriptions.apply'] = applied;
        });

        test('replays, then sends ready, refreshes the rooms it changed and sends their states', () => {
            results['publisher.classifyHello'] = 'replay';
            const message = { type: 'hello', epoch: 'e1', last_seq: 3, rooms: ['r1', 'r2'] };

            new HelloHandler(parts).handle(socket, message);

            assert.deepEqual(calls, [
                ['subscriptions.resolve', IDENTITY, ['r1', 'r2']],
                ['publisher.classifyHello', 'e1', 3],
                ['subscriptions.apply', socket, subscription],
                ['votes.dropHolds', socket, ['r0']],
                ['publisher.replay', socket, 3],
                ['connections.send', socket, { type: 'ready', epoch: 'e1', seq: 7 }],
                ['presence.refreshRooms', applied.affected, { skipSocket: socket }],
                ['roomStates.send', socket, subscription.rooms],
            ]);
        });

        test('a client that has to resync is told so before ready', () => {
            results['publisher.classifyHello'] = 'resync';

            new HelloHandler(parts).handle(socket, { type: 'hello', epoch: 'old', last_seq: 3, rooms: [] });

            assert.deepEqual(sentTypes(), ['resync', 'ready']);
            assert.equal(hasReplayed(), false);
        });

        test('a fresh client gets neither a replay nor a resync', () => {
            results['publisher.classifyHello'] = 'fresh';

            new HelloHandler(parts).handle(socket, { type: 'hello', epoch: null, last_seq: null, rooms: [] });

            assert.deepEqual(sentTypes(), ['ready']);
            assert.equal(hasReplayed(), false);
        });
    });

    describe('rooms', () => {
        test('is ignored before hello', () => {
            results['subscriptions.isSubscribed'] = false;

            new RoomsHandler(parts).handle(socket, { type: 'rooms', rooms: ['r1'] });

            assert.deepEqual(calls, [['subscriptions.isSubscribed', socket]]);
        });

        test('sends rooms-ok, refreshes the rooms it changed and sends the states of the added ones', () => {
            const subscription = { rooms: new Set(['r1']), allRooms: false };
            const applied = { added: ['r1'], removed: ['r2'], affected: new Set(['r1', 'r2']) };
            results['subscriptions.isSubscribed'] = true;
            results['subscriptions.resolve'] = subscription;
            results['subscriptions.apply'] = applied;

            new RoomsHandler(parts).handle(socket, { type: 'rooms', rooms: ['r1'] });

            assert.deepEqual(calls, [
                ['subscriptions.isSubscribed', socket],
                ['subscriptions.resolve', IDENTITY, ['r1']],
                ['subscriptions.apply', socket, subscription],
                ['votes.dropHolds', socket, ['r2']],
                ['connections.send', socket, { type: 'rooms-ok', seq: 7 }],
                ['presence.refreshRooms', applied.affected, { skipSocket: socket }],
                ['roomStates.send', socket, ['r1']],
            ]);
        });
    });

    test('vote-hold, vote-release and entry-status go to their manager unchanged', () => {
        const hold = { type: 'vote-hold', room_id: 'r1', topic: 'host', option: 'p1' };
        const release = { type: 'vote-release', room_id: 'r1', topic: 'host' };
        const entry = { type: 'entry-status', room_id: 'r1', state: 'typing', round: 2 };

        new VoteHoldHandler(parts).handle(socket, hold);
        new VoteReleaseHandler(parts).handle(socket, release);
        new EntryStatusHandler(parts).handle(socket, entry);

        assert.deepEqual(calls, [
            ['votes.hold', socket, hold],
            ['votes.release', socket, release],
            ['entries.receive', socket, entry],
        ]);
    });
});
