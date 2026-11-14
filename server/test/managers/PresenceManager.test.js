import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { Clock } from '../../src/domain/clock.js';
import { hostOfflineSinceOf, onlinePlayerIdsOf, PresenceManager } from '../../src/managers/PresenceManager.js';
import { SubscriptionManager } from '../../src/managers/SubscriptionManager.js';
import {
    FakeSocket,
    createFakeConnections,
    createFakePlayers,
    createFakeRooms,
} from './fakeSockets.js';

// PresenceManager over fake sockets, a fixed list of Players and the real SubscriptionManager. Ann
// and Bob play in r1; the admin plays nowhere and may watch "*".

const ANN = 'ann@example.com';
const BOB = 'bob@example.com';
const ADMIN = 'admin@example.com';
const START = Date.parse('2030-01-01T00:00:00.000Z');

describe('PresenceManager', () => {
    let time;
    let players;
    let playerStore;
    let connections;
    let subscriptions;
    let statsChanges;
    let refreshes;
    let presence;

    beforeEach(() => {
        time = START;
        players = [
            { id: 'ann-1', room_id: 'r1', email: ANN },
            { id: 'bob-1', room_id: 'r1', email: BOB, last_seen: '2029-12-31T00:00:00.000Z' },
        ];
        playerStore = createFakePlayers(players);
        connections = createFakeConnections();
        subscriptions = new SubscriptionManager({
            connections,
            players: playerStore,
            isAdmin: (identity) => identity.email === ADMIN,
        });
        statsChanges = 0;
        refreshes = [];
        presence = new PresenceManager({
            rooms: createFakeRooms([{ id: 'r1', code: 'AB12CD', status: 'playing', current_round: 1, max_score: 200 }]),
            players: playerStore,
            clock: new Clock(() => time),
            connections,
            subscriptions,
            onStatsChanged: () => {
                statsChanges += 1;
            },
            onRefreshed: (roomId, presencePlayers, options) => {
                refreshes.push({ roomId, presencePlayers, options });
            },
        });
    });

    /**
     * A live socket for `email` subscribed to `requested`, in the client set. A test sets its
     * `isLive` to false to make it stale.
     */
    function subscribe(email, requested) {
        const socket = new FakeSocket(email);
        socket.isLive = true;
        subscriptions.register(socket);
        subscriptions.apply(socket, subscriptions.resolve(socket.identity, requested));
        connections.clients.add(socket);
        return socket;
    }

    function onlineOf(message) {
        return message.players.map((player) => [player.player_id, player.online]);
    }

    describe('refresh', () => {
        test('sends the room its presence, except to the skipped socket, then hands it on', () => {
            const ann = subscribe(ANN, ['r1']);
            const bob = subscribe(BOB, ['r1']);
            const admin = subscribe(ADMIN, ['*']);

            presence.refresh('r1', { skipSocket: bob });

            const [message] = ann.messages();
            assert.equal(message.type, 'presence');
            assert.equal(message.room_id, 'r1');
            assert.deepEqual(onlineOf(message), [['ann-1', true], ['bob-1', true]]);
            assert.deepEqual(admin.messages(), [message]);
            assert.deepEqual(bob.sent, []);
            assert.equal(statsChanges, 1);
            assert.deepEqual(refreshes, [
                { roomId: 'r1', presencePlayers: message.players, options: { force: false, skipSocket: bob } },
            ]);
        });

        test('an unchanged presence is not sent again unless forced, but always ends in onRefreshed', () => {
            const ann = subscribe(ANN, ['r1']);
            presence.refresh('r1');

            presence.refresh('r1');
            assert.equal(ann.sent.length, 1);
            assert.equal(statsChanges, 1);

            presence.refresh('r1', { force: true });
            assert.equal(ann.sent.length, 2);
            assert.equal(statsChanges, 2);
            assert.equal(refreshes.length, 3);
        });

        test('only live, explicit subscriptions make a player online', () => {
            // The admin plays in r1 here too, so a "*" socket counting as online would show.
            players.push({ id: 'admin-1', room_id: 'r1', email: ADMIN });
            const ann = subscribe(ANN, ['r1']);
            ann.isLive = false;
            subscribe(ADMIN, ['*']);
            const bobElsewhere = subscribe(BOB, []);

            presence.refresh('r1');

            assert.deepEqual(presence.playersOf('r1').map((player) => player.online), [false, false, false]);
            assert.equal(presence.hasPlayersOnline('r1'), false);
            assert.deepEqual(bobElsewhere.sent, []);
        });

        test('a player going offline gets last_seen written once, at the clock time', () => {
            const ann = subscribe(ANN, ['r1']);
            subscribe(BOB, ['r1']);
            presence.refresh('r1');

            time += 5000;
            ann.isLive = false;
            presence.refresh('r1');
            presence.refresh('r1');

            const expected = new Date(START + 5000).toISOString();
            assert.deepEqual(playerStore.writes, [['ann-1', { last_seen: expected }]]);
            assert.deepEqual(presence.playersOf('r1'), [
                { player_id: 'ann-1', online: false, last_seen: expected },
                { player_id: 'bob-1', online: true, last_seen: '2029-12-31T00:00:00.000Z' },
            ]);
        });

        test('a room nobody explicitly subscribes to is not cached', () => {
            subscribe(ADMIN, ['*']);

            presence.refresh('r1');

            assert.equal(presence.playersOf('r1'), null);
            assert.equal(presence.hasPlayersOnline('r1'), false);
        });

        test('refreshRooms refreshes each room in order with the same options', () => {
            subscribe(ANN, ['r1']);

            presence.refreshRooms(['r1', 'r2'], { force: true });

            assert.deepEqual(refreshes.map((refresh) => [refresh.roomId, refresh.options.force]), [
                ['r1', true],
                ['r2', true],
            ]);
        });
    });

    describe('reading', () => {
        test('sendState sends the cached presence, and nothing for a room not cached', () => {
            const ann = subscribe(ANN, ['r1']);
            presence.refresh('r1');
            const late = subscribe(BOB, ['r1']);

            presence.sendState(late, 'r1');
            presence.sendState(late, 'r2');

            assert.deepEqual(late.sent, ann.sent);
        });

        test('hasPlayersOnline is true while one of the room\'s players is online', () => {
            subscribe(ANN, ['r1']);
            presence.refresh('r1');

            assert.equal(presence.hasPlayersOnline('r1'), true);
            assert.equal(presence.hasPlayersOnline('r2'), false);
        });

        test('buildRoomStats counts the cached rooms and the people online', () => {
            subscribe(ANN, ['r1']);
            subscribe(ADMIN, ['*']);
            presence.refresh('r1');

            assert.deepEqual(presence.buildRoomStats(), {
                playersOnline: 1,
                roomsLive: 1,
                rooms: [{ code: 'AB12CD', status: 'playing', round: 1, maxScore: 200, online: 1, players: 2 }],
            });
        });

        test('buildRoomStats counts a person once and leaves out stale and "*" sockets', () => {
            players.push({ id: 'admin-1', room_id: 'r1', email: ADMIN });
            subscribe(ANN, ['r1']);
            subscribe(ANN, ['r1']);
            const bob = subscribe(BOB, ['r1']);
            bob.isLive = false;
            subscribe(ADMIN, ['*']);

            assert.equal(presence.buildRoomStats().playersOnline, 1);
        });
    });
});

describe('presence player lists', () => {
    const list = [
        { player_id: 'a', online: true, last_seen: null },
        { player_id: 'b', online: false, last_seen: '2030-01-01T00:00:10.000Z' },
        { player_id: 'c', online: false, last_seen: null },
    ];

    test('onlinePlayerIdsOf lists the online ids in order', () => {
        assert.deepEqual(onlinePlayerIdsOf(list), ['a']);
    });

    test('hostOfflineSinceOf is the offline host\'s last_seen in ms, else null', () => {
        assert.equal(hostOfflineSinceOf(list, 'b'), Date.parse('2030-01-01T00:00:10.000Z'));
        assert.equal(hostOfflineSinceOf(list, 'a'), null);
        assert.equal(hostOfflineSinceOf(list, 'c'), null);
        assert.equal(hostOfflineSinceOf(list, null), null);
    });
});
