import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { EventPublisher } from '../../src/managers/EventPublisher.js';
import { SubscriptionManager } from '../../src/managers/SubscriptionManager.js';
import { EventRepository } from '../../src/repositories/EventRepository.js';
import { openTempStore } from '../actions/roomFixture.js';
import { FakeSocket, createFakeConnections, createPlayerReader } from './fakeSockets.js';

// EventPublisher on a real event log (a temp store) with fake sockets. Ann plays in r1 and Bob in
// r2; who receives what is SubscriptionManager's rule, used here as it is in the hub.

const ANN = 'ann@example.com';
const BOB = 'bob@example.com';
const ADMIN = 'admin@example.com';

describe('EventPublisher', () => {
    let temp;
    let connections;
    let subscriptions;
    let publisher;

    beforeEach(() => {
        temp = openTempStore();
        const players = [
            { id: 'ann-1', room_id: 'r1', email: ANN },
            { id: 'bob-1', room_id: 'r2', email: BOB },
        ];
        connections = createFakeConnections();
        subscriptions = new SubscriptionManager({
            connections,
            players: createPlayerReader(players),
            isAdmin: (identity) => identity.email === ADMIN,
        });
        publisher = new EventPublisher({ eventLog: temp.store.eventLog, connections, subscriptions });
    });

    afterEach(() => {
        temp.close();
    });

    /** A socket for `email` subscribed to `requested`, in the client set. */
    function subscribe(email, requested) {
        const socket = new FakeSocket(email);
        subscriptions.register(socket);
        subscriptions.apply(socket, subscriptions.resolve(socket.identity, requested));
        connections.clients.add(socket);
        return socket;
    }

    function playerEvent(id, roomId) {
        return { entity: 'Player', type: 'update', record: { id, room_id: roomId } };
    }

    describe('publishAll', () => {
        test('numbers, stores and sends each event to the sockets that may receive it', () => {
            const ann = subscribe(ANN, ['r1']);
            const bob = subscribe(BOB, ['r2']);
            const firstSeq = publisher.seq + 1;

            const published = publisher.publishAll(
                [playerEvent('ann-1', 'r1'), { entity: 'GameRoom', type: 'update', record: { id: 'r2' } }],
                { roomVersion: 4 },
            );

            assert.deepEqual(published, [
                { roomId: 'r1', entity: 'Player' },
                { roomId: 'r2', entity: 'GameRoom' },
            ]);
            assert.equal(publisher.seq, firstSeq + 1);

            const [annEvent] = ann.messages();
            assert.equal(ann.sent.length, 1);
            assert.equal(annEvent.type, 'event');
            assert.equal(annEvent.seq, firstSeq);
            assert.equal(annEvent.entity, 'Player');
            assert.equal(annEvent.room_version, 4);
            assert.deepEqual(
                { type: annEvent.event.type, id: annEvent.event.id, data: annEvent.event.data },
                { type: 'update', id: 'ann-1', data: { id: 'ann-1', room_id: 'r1' } },
            );
            assert.equal(typeof annEvent.event.timestamp, 'string');

            assert.deepEqual(bob.messages().map((message) => [message.seq, message.entity]), [[firstSeq + 1, 'GameRoom']]);
        });

        test('an event without a room reaches only "*" sockets, and room_version defaults to null', () => {
            const ann = subscribe(ANN, ['r1']);
            const admin = subscribe(ADMIN, ['*']);

            const published = publisher.publishAll([{ entity: 'Note', type: 'create', record: { id: 'n1' } }]);

            assert.deepEqual(published, [{ roomId: null, entity: 'Note' }]);
            assert.deepEqual(ann.sent, []);
            assert.deepEqual(admin.messages().map((message) => message.room_version), [null]);
        });

        test('each event is sent under the guard, so one failed send does not stop the rest', () => {
            const ann = subscribe(ANN, ['r1']);
            const failures = [];
            connections.runGuarded = (label, handler) => {
                try {
                    handler();
                } catch {
                    failures.push(label);
                }
            };
            let sends = 0;
            ann.send = (text) => {
                sends += 1;
                if (sends === 1) {
                    throw new Error('send failed');
                }
                ann.sent.push(text);
            };

            publisher.publishAll([playerEvent('ann-1', 'r1'), playerEvent('ann-1', 'r1')]);

            assert.deepEqual(failures, ['Player event']);
            assert.equal(ann.sent.length, 1);
        });

        test('a failed store sends nothing and throws', () => {
            const ann = subscribe(ANN, ['r1']);
            const seqBefore = publisher.seq;
            const badEvent = { entity: 'Player', type: 'update', record: { id: 'x', room_id: 'r1', loop: null } };
            badEvent.record.loop = badEvent.record;

            assert.throws(() => publisher.publishAll([badEvent]));
            assert.deepEqual(ann.sent, []);
            assert.equal(publisher.seq, seqBefore);
        });
    });

    describe('classifyHello', () => {
        test('no epoch, or no last_seq at the right epoch, is fresh', () => {
            assert.equal(publisher.classifyHello(null, 3), 'fresh');
            assert.equal(publisher.classifyHello('', 3), 'fresh');
            assert.equal(publisher.classifyHello(publisher.epoch, null), 'fresh');
        });

        test('another epoch resyncs', () => {
            assert.equal(publisher.classifyHello('other-epoch', 0), 'resync');
        });

        test('replays when every later event is stored, and resyncs when the client is ahead', () => {
            assert.equal(publisher.classifyHello(publisher.epoch, 0), 'replay');

            publisher.publishAll([playerEvent('ann-1', 'r1'), playerEvent('ann-1', 'r1')]);
            const lastSeq = publisher.seq;
            assert.equal(publisher.classifyHello(publisher.epoch, lastSeq), 'replay');
            assert.equal(publisher.classifyHello(publisher.epoch, lastSeq - 2), 'replay');
            assert.equal(publisher.classifyHello(publisher.epoch, lastSeq + 1), 'resync');
        });

        test('resyncs a client whose next event was trimmed from the log', () => {
            // A second view of the same log that keeps only the newest event.
            const eventLog = new EventRepository(temp.store.database, { maxEvents: 1 });
            const trimming = new EventPublisher({ eventLog, connections, subscriptions });

            trimming.publishAll([playerEvent('ann-1', 'r1'), playerEvent('ann-1', 'r1')]);
            const lastSeq = trimming.seq;

            assert.equal(trimming.classifyHello(trimming.epoch, lastSeq - 1), 'replay');
            assert.equal(trimming.classifyHello(trimming.epoch, lastSeq - 2), 'resync');
        });
    });

    describe('replay', () => {
        test('sends the stored events after last_seq that the socket may receive', () => {
            const startSeq = publisher.seq;
            publisher.publishAll([
                playerEvent('ann-1', 'r1'),
                playerEvent('bob-1', 'r2'),
                { entity: 'ChatMessage', type: 'create', record: { id: 'c1', room_id: 'r1' } },
                playerEvent('ann-1', 'r1'),
            ]);
            const ann = subscribe(ANN, ['r1']);
            const admin = subscribe(ADMIN, ['*']);

            publisher.replay(ann, startSeq + 1);
            publisher.replay(admin, startSeq);

            assert.deepEqual(ann.messages().map((message) => message.seq), [startSeq + 3, startSeq + 4]);
            // "*" reads every room but skips chat for rooms the admin isn't in.
            assert.deepEqual(admin.messages().map((message) => message.seq), [startSeq + 1, startSeq + 2, startSeq + 4]);
        });
    });
});
