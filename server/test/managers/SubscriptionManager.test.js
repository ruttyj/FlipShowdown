import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { SubscriptionManager } from '../../src/managers/SubscriptionManager.js';
import { FakeSocket, createFakeConnections, createPlayerReader } from './fakeSockets.js';

// SubscriptionManager over fake sockets and a fixed list of Players: Ann plays in rooms r1 and r2,
// Bob in r1, and the admin in none.

const ANN = 'ann@example.com';
const BOB = 'bob@example.com';
const ADMIN = 'admin@example.com';

describe('SubscriptionManager', () => {
    let players;
    let connections;
    let subscriptions;

    beforeEach(() => {
        players = [
            { id: 'ann-1', room_id: 'r1', email: ANN },
            { id: 'ann-2', room_id: 'r2', email: ANN },
            { id: 'bob-1', room_id: 'r1', email: BOB },
            // A legacy record without a room never counts as membership.
            { id: 'ann-x', room_id: null, email: ANN },
        ];
        connections = createFakeConnections();
        subscriptions = new SubscriptionManager({
            connections,
            players: createPlayerReader(players),
            isAdmin: (identity) => identity.email === ADMIN,
        });
    });

    /** A registered socket for `email`, in the client set. */
    function connect(email) {
        const socket = new FakeSocket(email);
        subscriptions.register(socket);
        connections.clients.add(socket);
        return socket;
    }

    /** A socket for `email` subscribed to `requested` (resolved, so only allowed rooms count). */
    function subscribe(email, requested) {
        const socket = connect(email);
        subscriptions.apply(socket, subscriptions.resolve(socket.identity, requested));
        return socket;
    }

    describe('resolve', () => {
        test('keeps only the rooms the user plays in', () => {
            const subscription = subscriptions.resolve({ email: ANN }, ['r1', 'r3', 'r2', 7]);

            assert.deepEqual([...subscription.rooms], ['r1', 'r2']);
            assert.equal(subscription.allRooms, false);
        });

        test('"*" counts for admins only', () => {
            assert.equal(subscriptions.resolve({ email: ADMIN }, ['*']).allRooms, true);
            assert.equal(subscriptions.resolve({ email: ANN }, ['*']).allRooms, false);
        });

        test('anything but an array subscribes to nothing', () => {
            const subscription = subscriptions.resolve({ email: ANN }, 'r1');

            assert.deepEqual([...subscription.rooms], []);
            assert.equal(subscription.allRooms, false);
        });
    });

    describe('apply and unsubscribeAll', () => {
        test('a new socket receives nothing until it subscribes', () => {
            const socket = connect(ANN);

            assert.equal(socket.isSubscribed, false);
            assert.equal(subscriptions.canReceive(socket, 'r1', 'Player'), false);
        });

        test('apply reports added, removed and affected rooms', () => {
            const socket = subscribe(ANN, ['r1']);

            const change = subscriptions.apply(socket, { rooms: new Set(['r2']), allRooms: false });

            assert.deepEqual(change.added, ['r2']);
            assert.deepEqual(change.removed, ['r1']);
            assert.deepEqual([...change.affected], ['r1', 'r2']);
            assert.deepEqual([...socket.rooms], ['r2']);
            assert.equal(socket.isSubscribed, true);
        });

        test('unsubscribeAll clears the socket and returns its rooms', () => {
            const socket = subscribe(ANN, ['r1', 'r2', '*']);

            const rooms = subscriptions.unsubscribeAll(socket);

            assert.deepEqual([...rooms], ['r1', 'r2']);
            assert.equal(socket.isSubscribed, false);
            assert.equal(socket.rooms.size, 0);
            assert.equal(socket.allRooms, false);
        });

        test('dropNonMembers removes the room from sockets whose user left it', () => {
            const ann = subscribe(ANN, ['r1', 'r2']);
            const bob = subscribe(BOB, ['r1']);
            players.splice(players.findIndex((player) => player.id === 'ann-1'), 1);

            assert.deepEqual(subscriptions.dropNonMembers('r1'), [ann]);
            assert.deepEqual([...ann.rooms], ['r2']);
            assert.deepEqual([...bob.rooms], ['r1']);
        });
    });

    describe('access', () => {
        test('canReceive: explicit rooms get everything, admin "*" everything but other rooms\' chat', () => {
            const ann = subscribe(ANN, ['r1']);
            const admin = subscribe(ADMIN, ['*']);
            players.push({ id: 'admin-2', room_id: 'r2', email: ADMIN });

            assert.equal(subscriptions.canReceive(ann, 'r1', 'ChatMessage'), true);
            assert.equal(subscriptions.canReceive(ann, 'r2', 'Player'), false);
            assert.equal(subscriptions.canReceive(admin, 'r1', 'Player'), true);
            assert.equal(subscriptions.canReceive(admin, 'r1', 'ChatMessage'), false);
            assert.equal(subscriptions.canReceive(admin, 'r2', 'ChatMessage'), true);
        });

        test('subscription checks tell explicit rooms from "*"', () => {
            const admin = subscribe(ADMIN, ['*']);

            assert.equal(subscriptions.isSubscribedToRoom(admin, 'r1'), true);
            assert.equal(subscriptions.isExplicitlySubscribed(admin, 'r1'), false);
            assert.equal(subscriptions.hasSubscribers('r1'), false);

            subscribe(BOB, ['r1']);
            assert.equal(subscriptions.hasSubscribers('r1'), true);
        });

        test('isMember compares canonical emails', () => {
            assert.equal(subscriptions.isMember(ANN, 'r2'), true);
            assert.equal(subscriptions.isMember(BOB, 'r2'), false);
        });

        test('findSubscribedPlayer needs an explicit subscription and a Player', () => {
            const ann = subscribe(ANN, ['r1']);
            const admin = subscribe(ADMIN, ['*']);

            assert.equal(subscriptions.findSubscribedPlayer(ann, 'r1').id, 'ann-1');
            assert.equal(subscriptions.findSubscribedPlayer(ann, 'r2'), null);
            assert.equal(subscriptions.findSubscribedPlayer(admin, 'r1'), null);

            players.splice(players.findIndex((player) => player.id === 'ann-1'), 1);
            assert.equal(subscriptions.findSubscribedPlayer(ann, 'r1'), null);
        });
    });

    describe('sendToRoom', () => {
        test('sends to explicit and "*" sockets of the room, except the skipped one', () => {
            const ann = subscribe(ANN, ['r1']);
            const bob = subscribe(BOB, ['r1']);
            const admin = subscribe(ADMIN, ['*']);
            const elsewhere = subscribe(ANN, ['r2']);
            const unsubscribed = connect(BOB);

            subscriptions.sendToRoom('r1', { type: 'vote' }, bob);

            assert.deepEqual(ann.messages(), [{ type: 'vote' }]);
            assert.deepEqual(admin.messages(), [{ type: 'vote' }]);
            assert.deepEqual(bob.sent, []);
            assert.deepEqual(elsewhere.sent, []);
            assert.deepEqual(unsubscribed.sent, []);
        });
    });
});
