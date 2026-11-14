import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { Clock } from '../../src/domain/clock.js';
import { Lifecycle } from '../../src/managers/Lifecycle.js';
import { SubscriptionManager } from '../../src/managers/SubscriptionManager.js';
import { VoteManager } from '../../src/managers/VoteManager.js';
import {
    FakeSocket,
    createFakeConnections,
    createFakePlayers,
    createFakeRooms,
    createRecordingLogger,
} from './fakeSockets.js';

// VoteManager over fake sockets, fixed Players and GameRooms, the real SubscriptionManager and a
// fake presence. Ann (host), Bob and Cat play in r1. Two topics: `finish` needs everyone, and in
// `host` the online host decides alone. The vote timers run on node:test's mock timers; the clock
// the snapshots read is set by hand.

const ANN = 'ann@example.com';
const BOB = 'bob@example.com';
const CAT = 'cat@example.com';
const ADMIN = 'admin@example.com';
const HOLD_MS = 1000;
const GRACE_MS = 2000;
const START = Date.parse('2030-01-01T00:00:00.000Z');

describe('VoteManager', () => {
    let time;
    let room;
    let roomStore;
    let voteTopics;
    let connections;
    let subscriptions;
    let cachedPresence;
    let logger;
    let resolved;
    let resolveResult;
    let lifecycle;
    let votes;

    beforeEach(() => {
        mock.timers.enable({ apis: ['setTimeout'] });
        time = START;
        room = { id: 'r1', host_player_id: 'ann-1', status: 'playing' };
        const playerStore = createFakePlayers([
            { id: 'ann-1', room_id: 'r1', email: ANN },
            { id: 'bob-1', room_id: 'r1', email: BOB },
            { id: 'cat-1', room_id: 'r1', email: CAT },
        ]);
        connections = createFakeConnections();
        subscriptions = new SubscriptionManager({
            connections,
            players: playerStore,
            isAdmin: (identity) => identity.email === ADMIN,
        });
        cachedPresence = new Map();
        logger = createRecordingLogger();
        resolved = [];
        resolveResult = { status: 200, body: {} };
        lifecycle = new Lifecycle({ logger });

        const isOpen = (gameRoom) => gameRoom !== null && gameRoom.status === 'playing';
        roomStore = createFakeRooms([room]);
        voteTopics = {
            finish: {
                validateOption: (gameRoom, players, option) => isOpen(gameRoom) && option === 'yes',
                resolve: (roomId, option) => {
                    resolved.push([roomId, option]);
                    return resolveResult;
                },
            },
            host: {
                hostDecides: true,
                validateOption: (gameRoom, players, option) => {
                    return isOpen(gameRoom) && players.some((player) => player.id === option);
                },
                resolve: () => ({ status: 200, body: {} }),
            },
        };
        votes = new VoteManager({
            rooms: roomStore,
            players: playerStore,
            clock: new Clock(() => time),
            connections,
            subscriptions,
            presence: { playersOf: (roomId) => cachedPresence.get(roomId) ?? null },
            lifecycle,
            logger,
            voteTopics,
            holdMs: HOLD_MS,
            hostGraceMs: GRACE_MS,
        });
    });

    afterEach(() => {
        votes.close();
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

    /** Presence players for r1 with these ids online; the others were never seen. */
    function presenceWith(...onlineIds) {
        const players = [];
        for (const id of ['ann-1', 'bob-1', 'cat-1']) {
            players.push({ player_id: id, online: onlineIds.includes(id), last_seen: null });
        }
        return players;
    }

    /** Ann and Bob subscribed and online in r1, their sockets cleared of the setup messages. */
    function annAndBobOnline() {
        const ann = subscribe(ANN, ['r1']);
        const bob = subscribe(BOB, ['r1']);
        votes.refreshRoom('r1', presenceWith('ann-1', 'bob-1'));
        ann.sent.length = 0;
        bob.sent.length = 0;
        return { ann, bob };
    }

    function votesOf(socket, topic) {
        return socket.messages().filter((message) => message.type === 'vote' && message.topic === topic);
    }

    describe('refreshRoom', () => {
        test('sends every topic its new electorate, except to the skipped socket', () => {
            const ann = subscribe(ANN, ['r1']);
            const bob = subscribe(BOB, ['r1']);

            votes.refreshRoom('r1', presenceWith('ann-1', 'bob-1'), { skipSocket: bob });

            assert.deepEqual(ann.messages(), [
                { type: 'vote', room_id: 'r1', topic: 'finish', eligible: ['ann-1', 'bob-1'], holds: [], pending: null, unlocks_in_ms: 0 },
                { type: 'vote', room_id: 'r1', topic: 'host', eligible: ['ann-1', 'bob-1'], holds: [], pending: null, unlocks_in_ms: 0 },
            ]);
            assert.deepEqual(bob.sent, []);
        });

        test('the same electorate is only sent again when forced', () => {
            const { ann } = annAndBobOnline();

            votes.refreshRoom('r1', presenceWith('ann-1', 'bob-1'));
            assert.deepEqual(ann.sent, []);

            votes.refreshRoom('r1', presenceWith('ann-1', 'bob-1'), { force: true });
            assert.equal(ann.sent.length, 2);
        });

        test('a room nobody explicitly subscribes to any more is forgotten, pending vote and all', () => {
            const { ann, bob } = annAndBobOnline();
            votes.hold(ann, { room_id: 'r1', topic: 'finish', option: 'yes' });
            votes.hold(bob, { room_id: 'r1', topic: 'finish', option: 'yes' });
            const admin = subscribe(ADMIN, ['*']);
            subscriptions.apply(ann, { rooms: new Set(), allRooms: false });
            subscriptions.apply(bob, { rooms: new Set(), allRooms: false });

            votes.refreshRoom('r1', presenceWith());
            mock.timers.tick(HOLD_MS);

            assert.deepEqual(admin.sent, []);
            assert.deepEqual(resolved, []);
            votes.sendStates(admin, 'r1');
            assert.deepEqual(votesOf(admin, 'finish')[0].eligible, []);
        });

        test('an offline host who was seen recently locks the votes until the grace time ends', () => {
            const ann = subscribe(ANN, ['r1']);
            const bob = subscribe(BOB, ['r1']);
            const players = presenceWith('bob-1');
            players[0].last_seen = new Date(START - 500).toISOString();

            votes.refreshRoom('r1', players);
            assert.equal(votesOf(bob, 'finish')[0].unlocks_in_ms, GRACE_MS - 500);

            time += GRACE_MS - 500;
            mock.timers.tick(GRACE_MS - 500);
            const unlocked = votesOf(bob, 'finish');
            assert.equal(unlocked.length, 2);
            assert.equal(unlocked[1].unlocks_in_ms, 0);
            assert.deepEqual(ann.sent, bob.sent);
        });
    });

    describe('with the room gone', () => {
        test('there is no host, so an offline host who was seen recently locks nothing', () => {
            const bob = subscribe(BOB, ['r1']);
            const players = presenceWith('bob-1');
            players[0].last_seen = new Date(START - 500).toISOString();
            roomStore.get = () => null;

            votes.refreshRoom('r1', players);

            assert.equal(votesOf(bob, 'finish')[0].unlocks_in_ms, 0);
        });
    });

    describe('roomHostChanged', () => {
        test('re-evaluates the votes against the cached presence', () => {
            const { ann } = annAndBobOnline();
            room.host_player_id = 'cat-1';
            const players = presenceWith('ann-1', 'bob-1');
            players[2].last_seen = new Date(START - 500).toISOString();
            cachedPresence.set('r1', players);

            votes.roomHostChanged('r1');

            assert.deepEqual(votesOf(ann, 'finish').map((message) => message.unlocks_in_ms), [GRACE_MS - 500]);
        });

        test('does nothing for a room with no cached presence', () => {
            const { ann } = annAndBobOnline();
            room.host_player_id = 'cat-1';

            votes.roomHostChanged('r1');

            assert.deepEqual(ann.sent, []);
        });
    });

    describe('hold and release', () => {
        test('rejects a malformed message, an unknown topic, a non-member and an invalid option', () => {
            const { ann } = annAndBobOnline();
            const admin = subscribe(ADMIN, ['*']);

            votes.hold(ann, { room_id: 'r1' });
            votes.hold(ann, { room_id: 'r1', topic: 'toString', option: 'yes' });
            votes.release(admin, { room_id: 'r1', topic: 'finish' });
            votes.hold(ann, { room_id: 'r1', topic: 'finish', option: 'no' });
            votes.hold(ann, { room_id: 'r1', topic: 'finish', option: 7 });

            assert.deepEqual(ann.messages().map((message) => [message.type, message.topic, message.code]), [
                ['vote-error', null, 'bad_request'],
                ['vote-error', 'toString', 'unknown_topic'],
                ['vote-error', 'finish', 'invalid_option'],
                ['vote-error', 'finish', 'invalid_option'],
            ]);
            assert.deepEqual(admin.messages(), [
                { type: 'vote-error', room_id: 'r1', topic: 'finish', code: 'not_member' },
            ]);
        });

        test('a hold and a release are sent to the room', () => {
            const { ann, bob } = annAndBobOnline();

            votes.hold(ann, { room_id: 'r1', topic: 'finish', option: 'yes' });
            votes.release(ann, { room_id: 'r1', topic: 'finish' });
            votes.release(ann, { room_id: 'r1', topic: 'finish' });

            assert.deepEqual(votesOf(bob, 'finish').map((message) => message.holds), [
                [{ player_id: 'ann-1', option: 'yes' }],
                [],
            ]);
        });
    });

    describe('passing', () => {
        test('a unanimous hold clears the vote, runs the action, then sends vote-passed', () => {
            const { ann, bob } = annAndBobOnline();
            votes.hold(ann, { room_id: 'r1', topic: 'finish', option: 'yes' });
            votes.hold(bob, { room_id: 'r1', topic: 'finish', option: 'yes' });
            assert.equal(votesOf(ann, 'finish').at(-1).pending.option, 'yes');
            ann.sent.length = 0;

            mock.timers.tick(HOLD_MS);

            assert.deepEqual(resolved, [['r1', 'yes']]);
            assert.deepEqual(ann.messages(), [
                { type: 'vote', room_id: 'r1', topic: 'finish', eligible: ['ann-1', 'bob-1'], holds: [], pending: null, unlocks_in_ms: 0 },
                { type: 'vote-passed', room_id: 'r1', topic: 'finish', option: 'yes' },
            ]);
        });

        test('the online host alone decides a host-decides topic', () => {
            const { ann } = annAndBobOnline();

            votes.hold(ann, { room_id: 'r1', topic: 'host', option: 'bob-1' });
            mock.timers.tick(HOLD_MS);

            assert.deepEqual(ann.messages().at(-1), { type: 'vote-passed', room_id: 'r1', topic: 'host', option: 'bob-1' });
        });

        test('a failed action is logged and sends no vote-passed', () => {
            const { ann, bob } = annAndBobOnline();
            resolveResult = { status: 409, body: { code: 'round_open' } };
            votes.hold(ann, { room_id: 'r1', topic: 'finish', option: 'yes' });
            votes.hold(bob, { room_id: 'r1', topic: 'finish', option: 'yes' });

            mock.timers.tick(HOLD_MS);

            assert.deepEqual(logger.calls, [['warn', 'Vote finish in room r1 failed: round_open']]);
            assert.equal(ann.messages().at(-1).type, 'vote');
        });

        test('an option the room no longer allows is not carried out', () => {
            const { ann, bob } = annAndBobOnline();
            votes.hold(ann, { room_id: 'r1', topic: 'finish', option: 'yes' });
            votes.hold(bob, { room_id: 'r1', topic: 'finish', option: 'yes' });
            room.status = 'closed';
            ann.sent.length = 0;

            mock.timers.tick(HOLD_MS);

            assert.deepEqual(resolved, []);
            assert.deepEqual(ann.messages().map((message) => message.type), ['vote']);
        });

        test('an action that throws is logged under the guard', () => {
            const { ann, bob } = annAndBobOnline();
            const error = new Error('action failed');
            voteTopics.finish.resolve = () => {
                throw error;
            };
            votes.hold(ann, { room_id: 'r1', topic: 'finish', option: 'yes' });
            votes.hold(bob, { room_id: 'r1', topic: 'finish', option: 'yes' });

            mock.timers.tick(HOLD_MS);

            assert.deepEqual(logger.calls, [['error', 'Realtime vote failed', error]]);
        });

        test('close cancels a pending vote', () => {
            const { ann, bob } = annAndBobOnline();
            votes.hold(ann, { room_id: 'r1', topic: 'finish', option: 'yes' });
            votes.hold(bob, { room_id: 'r1', topic: 'finish', option: 'yes' });

            votes.close();
            mock.timers.tick(HOLD_MS);

            assert.deepEqual(resolved, []);
        });
    });

    describe('dropping holds', () => {
        test('dropHolds lets go in the given rooms and tells them', () => {
            const { ann, bob } = annAndBobOnline();
            votes.hold(ann, { room_id: 'r1', topic: 'finish', option: 'yes' });
            bob.sent.length = 0;

            votes.dropHolds(ann, ['r1']);
            assert.deepEqual(votesOf(bob, 'finish').map((message) => message.holds), [[]]);
        });

        test('dropAllHolds lets go everywhere and tells the rooms', () => {
            const { ann, bob } = annAndBobOnline();
            votes.hold(ann, { room_id: 'r1', topic: 'host', option: 'bob-1' });
            bob.sent.length = 0;

            votes.dropAllHolds(ann);

            assert.deepEqual(votesOf(bob, 'host').map((message) => message.holds), [[]]);
        });

        test('forgetHolds lets go without telling anyone', () => {
            const { ann, bob } = annAndBobOnline();
            votes.hold(ann, { room_id: 'r1', topic: 'finish', option: 'yes' });
            bob.sent.length = 0;

            votes.forgetHolds(ann, 'r1');

            assert.deepEqual(bob.sent, []);
            votes.sendStates(bob, 'r1');
            assert.deepEqual(votesOf(bob, 'finish')[0].holds, []);
        });
    });
});
