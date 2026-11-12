// The room channel's translation from wire messages to the game's terms, over a stand-in
// connection. Run with `npm test`. Its recovery is tested through the hooks that use it, and against
// the real server in server/test/realtimeChannel.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomChannel } from '../src/api/roomChannel.js';

const ROOM_ID = 'r1';
const TOPIC = 'make-host';

/** The part of RealtimeConnection the channel uses; `emit` delivers a message to its listeners. */
function makeConnection() {
    const listeners = { ready: [], resync: [], status: [], presence: [], vote: [], entryStatus: [], entity: [] };
    const addTo = (name) => (listener) => {
        listeners[name].push(listener);
        return () => {
            listeners[name] = listeners[name].filter((candidate) => candidate !== listener);
        };
    };

    return {
        rooms: [],
        status: 'live',
        setRooms(rooms) {
            this.rooms = rooms;
        },
        getStatus() {
            return this.status;
        },
        subscribe: (_entity, listener) => addTo('entity')(listener),
        onReady: addTo('ready'),
        onResync: addTo('resync'),
        onStatus: addTo('status'),
        onPresence: addTo('presence'),
        onVote: addTo('vote'),
        onEntryStatus: addTo('entryStatus'),
        emit(name, ...args) {
            for (const listener of listeners[name]) {
                listener(...args);
            }
        },
        listenerCount(name) {
            return listeners[name].length;
        },
    };
}

function voteMessage(overrides = {}) {
    return { type: 'vote', room_id: ROOM_ID, topic: TOPIC, eligible: ['a'], holds: [], pending: null, ...overrides };
}

function noop() {}

// --- Votes -----------------------------------------------------------------------

test('a vote state arrives in the game\'s terms, stamped with when it arrived', () => {
    const connection = makeConnection();
    const channel = createRoomChannel(connection);
    const before = Date.now();

    connection.emit('vote', voteMessage({
        holds: [{ player_id: 'a', option: 'x' }],
        pending: { option: 'x', remaining_ms: 2500 },
        unlocks_in_ms: 700,
    }));

    const { receivedAt, ...state } = channel.getVote(ROOM_ID, TOPIC);
    assert.ok(receivedAt >= before);
    assert.deepEqual(state, {
        eligible: ['a'],
        holds: [{ playerId: 'a', option: 'x' }],
        pending: { option: 'x', remainingMs: 2500 },
        unlocksInMs: 700,
    });
});

test('a vote message with only its identity gives empty defaults', () => {
    const connection = makeConnection();
    const channel = createRoomChannel(connection);

    connection.emit('vote', { type: 'vote', room_id: ROOM_ID, topic: TOPIC });

    const state = channel.getVote(ROOM_ID, TOPIC);
    assert.deepEqual(state, { eligible: [], holds: [], pending: null, unlocksInMs: 0, receivedAt: state.receivedAt });
});

test('vote states are kept per room and topic, and an outcome changes none of them', () => {
    const connection = makeConnection();
    const channel = createRoomChannel(connection);
    let changes = 0;
    channel.subscribeVotes(() => {
        changes += 1;
    });

    connection.emit('vote', voteMessage({ eligible: ['a', 'b'] }));
    connection.emit('vote', voteMessage({ topic: 'other', eligible: ['z'] }));
    connection.emit('vote', voteMessage({ room_id: 'r2', eligible: ['y'] }));
    connection.emit('vote', { type: 'vote-passed', room_id: ROOM_ID, topic: TOPIC, option: 'x' });
    connection.emit('vote', { type: 'vote-error', room_id: ROOM_ID, topic: TOPIC, code: 'bad_request' });

    assert.equal(changes, 3);
    assert.deepEqual(channel.getVote(ROOM_ID, TOPIC).eligible, ['a', 'b']);
    assert.deepEqual(channel.getVote(ROOM_ID, 'other').eligible, ['z']);
    assert.equal(channel.getVote('r3', TOPIC), null);
});

test('a ballot opened without callbacks ignores the outcome', () => {
    const connection = makeConnection();
    const channel = createRoomChannel(connection);
    channel.openBallot(ROOM_ID, TOPIC);

    assert.doesNotThrow(() => {
        connection.emit('vote', { type: 'vote-passed', room_id: ROOM_ID, topic: TOPIC, option: 'x' });
    });
});

// --- Rooms -------------------------------------------------------------------------

test('joining hands over record changes with their room version, and leaving lets go of everything', () => {
    const connection = makeConnection();
    const channel = createRoomChannel(connection);
    const changes = [];

    const leave = channel.joinRoom(ROOM_ID, {
        onRecordChange: (entity, event, meta) => changes.push({ entity, event, meta }),
        onPresence: noop,
        onStale: noop,
    });
    assert.deepEqual(connection.rooms, [ROOM_ID]);

    connection.emit('entity', { id: 'x' }, { room_version: 4, seq: 9 });
    assert.deepEqual(changes[0].meta, { roomVersion: 4 });
    assert.deepEqual(changes[0].event, { id: 'x' });

    leave();
    assert.deepEqual(connection.rooms, []);
    assert.equal(connection.listenerCount('entity'), 0);
    assert.equal(connection.listenerCount('presence'), 0);
    assert.equal(connection.listenerCount('ready'), 0);
});

test('presence is decoded, and only for the joined room', () => {
    const connection = makeConnection();
    const channel = createRoomChannel(connection);
    const received = [];
    channel.joinRoom(ROOM_ID, { onRecordChange: noop, onPresence: (players) => received.push(players), onStale: noop });

    connection.emit('presence', { room_id: 'other', players: [{ player_id: 'z', online: true }] });
    connection.emit('presence', { room_id: ROOM_ID, players: [{ player_id: 'a', online: true, last_seen: 'then' }] });
    connection.emit('presence', { room_id: ROOM_ID });

    assert.deepEqual(received, [[{ playerId: 'a', online: true, lastSeen: 'then' }], []]);
});

test('a joined room is told it is stale on ready and on resync', () => {
    const connection = makeConnection();
    const channel = createRoomChannel(connection);
    let staleCount = 0;
    channel.joinRoom(ROOM_ID, {
        onRecordChange: noop,
        onPresence: noop,
        onStale: () => {
            staleCount += 1;
        },
    });

    connection.emit('ready', { seq: 1 });
    connection.emit('resync');

    assert.equal(staleCount, 2);
});

// --- Entering cards -----------------------------------------------------------------

test('a list of who is entering is decoded, and a message without one empties it', () => {
    const connection = makeConnection();
    const channel = createRoomChannel(connection);
    const lists = [];
    const stop = channel.watchEntering(ROOM_ID, (entries) => lists.push(entries));

    connection.emit('entryStatus', { room_id: ROOM_ID, entries: [{ player_id: 'a', state: 'typing', round: 2 }] });
    connection.emit('entryStatus', { room_id: ROOM_ID });

    assert.deepEqual(lists, [[{ playerId: 'a', state: 'typing', round: 2 }], []]);

    stop();
    assert.equal(connection.listenerCount('entryStatus'), 0);
    assert.equal(connection.listenerCount('status'), 0);
});
