// Tests for the realtime/entities client. Run with `npm test` (node --test).

import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeConnection, realtimeUrlFor, reconnectDelay } from '../src/api/realtime.js';
import { createEntitiesProxy } from '../src/api/entities.js';

// --- Test doubles ------------------------------------------------------------

class FakeWebSocket {
    static instances = [];

    constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.sent = [];
        this.closeCalls = 0;
        FakeWebSocket.instances.push(this);
    }

    send(text) {
        this.sent.push(JSON.parse(text));
    }

    close() {
        this.closeCalls += 1;
        this.readyState = 3;
    }

    // Helpers that simulate the server side.
    open() {
        this.readyState = 1;
        this.onopen?.();
    }

    receive(message) {
        this.onmessage?.({ data: JSON.stringify(message) });
    }

    serverClose() {
        this.readyState = 3;
        this.onclose?.();
    }
}

function latestSocket() {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

/** Window, document and navigator.connection stand-ins that tests can fire events on. */
function createEnvironment() {
    const documentTarget = new EventTarget();
    documentTarget.visibilityState = 'visible';
    return {
        window: new EventTarget(),
        document: documentTarget,
        navigator: { connection: new EventTarget() },
    };
}

function createConnection({ environment = {}, fetchImpl = null } = {}) {
    const reloads = [];
    const connection = new RealtimeConnection({
        url: 'ws://test/api/realtime',
        WebSocketImpl: FakeWebSocket,
        environment,
        fetchImpl,
        reload: () => reloads.push(true),
    });
    return { connection, reloads };
}

/** Opens the latest socket and completes the handshake. */
function goLive(epoch = 'e1', seq = 0) {
    const socket = latestSocket();
    socket.open();
    socket.receive({ type: 'ready', epoch, seq });
    return socket;
}

/** Fails `count` connect attempts in a row, waiting out each pending backoff (Math.random is 1). */
function failConnects(connection, count) {
    for (let attempt = 0; attempt < count; attempt += 1) {
        const isWaitingToRetry = latestSocket().readyState === 3;
        if (isWaitingToRetry) {
            mock.timers.tick(reconnectDelay(connection.reconnectAttempts - 1, () => 1));
        }
        latestSocket().serverClose();
    }
}

/** Lets pending promise callbacks (e.g. the auth check) run; setImmediate isn't mocked. */
function flushPromises() {
    return new Promise((resolve) => {
        setImmediate(resolve);
    });
}

function eventMessage(seq, entity, id, roomVersion) {
    return {
        type: 'event',
        seq,
        entity,
        event: { type: 'update', id, data: { id }, timestamp: 'now' },
        room_version: roomVersion,
    };
}

function pageshowEvent(persisted) {
    const event = new Event('pageshow');
    event.persisted = persisted;
    return event;
}

beforeEach(() => {
    FakeWebSocket.instances = [];
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    mock.method(Math, 'random', () => 1);
    mock.method(console, 'error', () => {});
    mock.method(console, 'warn', () => {});
});

afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
});

// --- Pure helpers ----------------------------------------------------------------

test('realtimeUrlFor picks ws/wss from the page protocol', () => {
    assert.equal(realtimeUrlFor({ protocol: 'http:', host: 'localhost:5173' }), 'ws://localhost:5173/api/realtime');
    assert.equal(realtimeUrlFor({ protocol: 'https:', host: 'flip7.example.com' }), 'wss://flip7.example.com/api/realtime');
});

test('reconnectDelay doubles, caps at 10s and applies 50-100% jitter', () => {
    assert.equal(reconnectDelay(0, () => 1), 500);
    assert.equal(reconnectDelay(3, () => 1), 4000);
    assert.equal(reconnectDelay(10, () => 1), 10000);
    assert.equal(reconnectDelay(10, () => 0), 5000);
});

// --- Connection ------------------------------------------------------------------

test('connects lazily on first subscribe and shares one socket', () => {
    const { connection } = createConnection();
    assert.equal(FakeWebSocket.instances.length, 0);

    connection.subscribe('Player', () => {});
    connection.subscribe('GameRoom', () => {});
    assert.equal(FakeWebSocket.instances.length, 1);

    latestSocket().open();
    assert.deepEqual(latestSocket().sent, [{ type: 'hello', epoch: null, last_seq: null, rooms: [] }]);
});

test('dispatches events per entity and isolates throwing subscribers', async () => {
    const { connection } = createConnection();
    const received = [];
    connection.subscribe('Player', () => {
        throw new Error('boom');
    });
    connection.subscribe('Player', async () => {
        throw new Error('async boom');
    });
    connection.subscribe('Player', (event) => received.push(['player', event.id]));
    connection.subscribe('GameRoom', (event) => received.push(['room', event.id]));

    const socket = goLive();
    socket.receive(eventMessage(1, 'Player', 'p1'));
    socket.receive(eventMessage(2, 'GameRoom', 'r1'));
    await Promise.resolve();

    assert.deepEqual(received, [['player', 'p1'], ['room', 'r1']]);
    assert.equal(console.error.mock.callCount(), 2);
});

test('entity callbacks receive room_version and seq as a second argument', () => {
    const { connection } = createConnection();
    const received = [];
    connection.subscribe('GameRoom', (event, meta) => received.push([event.id, meta]));

    const socket = goLive();
    socket.receive(eventMessage(1, 'GameRoom', 'r1', 4));
    socket.receive(eventMessage(2, 'GameRoom', 'r1'));

    assert.deepEqual(received, [
        ['r1', { room_version: 4, seq: 1 }],
        ['r1', { room_version: null, seq: 2 }],
    ]);
});

test('reconnects with backoff and resumes from epoch/last_seq, skipping duplicates', () => {
    const { connection } = createConnection();
    const received = [];
    connection.subscribe('Player', (event) => received.push(event.id));

    const first = goLive('e1', 5);
    first.receive(eventMessage(6, 'Player', 'a'));
    first.serverClose();

    // Math.random is 1, so the first retry waits the full 500ms.
    mock.timers.tick(499);
    assert.equal(FakeWebSocket.instances.length, 1);
    mock.timers.tick(1);
    assert.equal(FakeWebSocket.instances.length, 2);

    const second = latestSocket();
    second.open();
    assert.deepEqual(second.sent[0], { type: 'hello', epoch: 'e1', last_seq: 6, rooms: [] });

    second.receive(eventMessage(6, 'Player', 'a-duplicate'));
    second.receive(eventMessage(7, 'Player', 'b'));
    second.receive({ type: 'ready', epoch: 'e1', seq: 7 });
    assert.deepEqual(received, ['a', 'b']);
});

test('backoff grows while connections fail and resets after ready', () => {
    const { connection } = createConnection();
    connection.subscribe('Player', () => {});

    latestSocket().serverClose(); // attempt 0 -> 500ms
    mock.timers.tick(500);
    latestSocket().serverClose(); // attempt 1 -> 1000ms
    mock.timers.tick(999);
    assert.equal(FakeWebSocket.instances.length, 2);
    mock.timers.tick(1);
    assert.equal(FakeWebSocket.instances.length, 3);

    goLive();
    mock.timers.tick(5_000);
    latestSocket().serverClose();
    mock.timers.tick(500);
    assert.equal(FakeWebSocket.instances.length, 4);
});

test('unsubscribe is idempotent and the socket closes after an idle grace period', () => {
    const { connection } = createConnection();
    const received = [];
    const unsubscribeA = connection.subscribe('Player', () => received.push('a'));
    const unsubscribeB = connection.subscribe('Player', () => received.push('b'));
    const socket = goLive();

    unsubscribeA();
    unsubscribeA();
    socket.receive(eventMessage(1, 'Player', 'x'));
    assert.deepEqual(received, ['b']);

    unsubscribeB();
    mock.timers.tick(4999);
    assert.equal(socket.closeCalls, 0);
    mock.timers.tick(1);
    assert.equal(socket.closeCalls, 1);

    // A later subscriber starts a fresh stream rather than resuming the old one.
    connection.subscribe('Player', () => {});
    latestSocket().open();
    assert.deepEqual(latestSocket().sent[0], { type: 'hello', epoch: null, last_seq: null, rooms: [] });
});

test('resubscribing within the grace period keeps the same socket', () => {
    const { connection } = createConnection();
    const unsubscribe = connection.subscribe('Player', () => {});
    goLive();

    unsubscribe();
    connection.subscribe('Player', () => {});
    mock.timers.tick(10_000);

    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(latestSocket().closeCalls, 0);
});

// --- Connect timeout -------------------------------------------------------------

test('a connect that does not open within 10s is closed and retried with backoff', () => {
    const { connection } = createConnection();
    connection.subscribe('Player', () => {});
    const stuck = latestSocket();

    mock.timers.tick(9_999);
    assert.equal(stuck.closeCalls, 0);
    mock.timers.tick(1);
    assert.equal(stuck.closeCalls, 1);
    assert.equal(FakeWebSocket.instances.length, 1);

    mock.timers.tick(500);
    assert.equal(FakeWebSocket.instances.length, 2);

    // A socket that opens in time is not timed out.
    latestSocket().open();
    mock.timers.tick(10_000);
    assert.equal(latestSocket().closeCalls, 0);
});

// --- Wake-up ---------------------------------------------------------------------

const wakeSources = [
    {
        name: 'visibilitychange to visible',
        fire: (environment) => {
            environment.document.visibilityState = 'visible';
            environment.document.dispatchEvent(new Event('visibilitychange'));
        },
    },
    {
        name: 'pageshow restored from the bfcache',
        fire: (environment) => environment.window.dispatchEvent(pageshowEvent(true)),
    },
    {
        name: 'resume',
        fire: (environment) => environment.document.dispatchEvent(new Event('resume')),
    },
    {
        name: 'online',
        fire: (environment) => environment.window.dispatchEvent(new Event('online')),
    },
    {
        name: 'navigator.connection change',
        fire: (environment) => environment.navigator.connection.dispatchEvent(new Event('change')),
    },
];

for (const source of wakeSources) {
    test(`wake on ${source.name}: reconnects now when closed, pings when open`, () => {
        const environment = createEnvironment();
        const { connection } = createConnection({ environment });
        connection.subscribe('Player', () => {});

        // Closed and waiting out a backoff delay: the wake skips it.
        latestSocket().serverClose();
        source.fire(environment);
        assert.equal(FakeWebSocket.instances.length, 2);

        // The pending backoff timer was cancelled by connect(), so no extra socket appears.
        const socket = goLive();
        mock.timers.tick(9_000);
        assert.equal(FakeWebSocket.instances.length, 2);

        source.fire(environment);
        assert.deepEqual(socket.sent.at(-1), { type: 'ping' });
        assert.equal(FakeWebSocket.instances.length, 2);
    });
}

test('pageshow without persisted (a normal load) is not a wake', () => {
    const environment = createEnvironment();
    const { connection } = createConnection({ environment });
    connection.subscribe('Player', () => {});

    latestSocket().serverClose();
    environment.window.dispatchEvent(pageshowEvent(false));
    assert.equal(FakeWebSocket.instances.length, 1);
});

test('visibilitychange to hidden is not a wake', () => {
    const environment = createEnvironment();
    const { connection } = createConnection({ environment });
    connection.subscribe('Player', () => {});

    latestSocket().serverClose();
    environment.document.visibilityState = 'hidden';
    environment.document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(FakeWebSocket.instances.length, 1);
});

test('a wake leaves a fresh connect attempt alone', () => {
    const environment = createEnvironment();
    const { connection } = createConnection({ environment });
    connection.subscribe('Player', () => {});

    environment.window.dispatchEvent(new Event('online'));
    environment.document.dispatchEvent(new Event('resume'));
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(latestSocket().closeCalls, 0);
});

// --- Ping / pong -----------------------------------------------------------------

test('pings every 10s while visible and keeps a socket that answers', () => {
    const environment = createEnvironment();
    const { connection } = createConnection({ environment });
    connection.subscribe('Player', () => {});
    const socket = goLive();

    mock.timers.tick(10_000);
    assert.deepEqual(socket.sent.at(-1), { type: 'ping' });
    socket.receive({ type: 'pong' });

    mock.timers.tick(10_000);
    socket.receive({ type: 'pong' });
    mock.timers.tick(10_000);
    socket.receive({ type: 'pong' });

    const pings = socket.sent.filter((message) => message.type === 'ping');
    assert.equal(pings.length, 3);
    assert.equal(FakeWebSocket.instances.length, 1);
});

test('does not ping while the page is hidden', () => {
    const environment = createEnvironment();
    const { connection } = createConnection({ environment });
    connection.subscribe('Player', () => {});
    const socket = goLive();

    environment.document.visibilityState = 'hidden';
    mock.timers.tick(60_000);

    const pings = socket.sent.filter((message) => message.type === 'ping');
    assert.equal(pings.length, 0);
    assert.equal(FakeWebSocket.instances.length, 1);
});

test('a missing pong marks the socket dead and reconnects', () => {
    const environment = createEnvironment();
    const { connection } = createConnection({ environment });
    connection.subscribe('Player', () => {});
    const socket = goLive();

    mock.timers.tick(10_000);
    mock.timers.tick(4_999);
    assert.equal(FakeWebSocket.instances.length, 1);
    mock.timers.tick(1);
    assert.equal(socket.closeCalls, 1);
    assert.equal(FakeWebSocket.instances.length, 2);
    assert.equal(connection.getStatus(), 'reconnecting');
});

test('a wake ping that gets no pong replaces the socket', () => {
    const environment = createEnvironment();
    const { connection } = createConnection({ environment });
    connection.subscribe('Player', () => {});
    const socket = goLive();

    environment.window.dispatchEvent(new Event('online'));
    mock.timers.tick(5_000);
    assert.equal(socket.closeCalls, 1);
    assert.equal(FakeWebSocket.instances.length, 2);
});

// --- Rooms -----------------------------------------------------------------------

test('setRooms is sent in hello and as a rooms message when connected', () => {
    const { connection } = createConnection();
    connection.setRooms(['room-1']);
    connection.subscribe('Player', () => {});

    const socket = latestSocket();
    socket.open();
    assert.deepEqual(socket.sent[0], { type: 'hello', epoch: null, last_seq: null, rooms: ['room-1'] });

    socket.receive({ type: 'ready', epoch: 'e1', seq: 0 });
    mock.timers.tick(5_000);
    connection.setRooms(['room-1', 'room-2']);
    assert.deepEqual(socket.sent.at(-1), { type: 'rooms', rooms: ['room-1', 'room-2'] });

    // While closed, the new list waits for the next hello.
    socket.serverClose();
    connection.setRooms(['room-3']);
    assert.equal(socket.sent.at(-1).type, 'rooms');
    mock.timers.tick(500);
    latestSocket().open();
    assert.deepEqual(latestSocket().sent[0].rooms, ['room-3']);
});

test('pagehide releases the rooms and a bfcache restore rejoins them', () => {
    const environment = createEnvironment();
    const { connection } = createConnection({ environment });
    connection.setRooms(['room-1']);
    connection.subscribe('Player', () => {});
    const socket = goLive();

    environment.window.dispatchEvent(new Event('pagehide'));
    assert.deepEqual(socket.sent.at(-1), { type: 'rooms', rooms: [] });

    environment.window.dispatchEvent(pageshowEvent(true));
    const afterRestore = socket.sent.slice(-2);
    assert.deepEqual(afterRestore, [{ type: 'rooms', rooms: ['room-1'] }, { type: 'ping' }]);
});

test('rooms-ok fires onReady and never moves last_seq backwards', () => {
    const { connection } = createConnection();
    const readies = [];
    connection.onReady((info) => readies.push(info));
    connection.setRooms(['room-1']);
    connection.subscribe('Player', () => {});

    const socket = goLive('e1', 10);
    socket.receive({ type: 'rooms-ok', seq: 7 });
    socket.receive({ type: 'rooms-ok', seq: 12 });
    socket.receive({ type: 'rooms-ok', seq: 11 });
    assert.deepEqual(readies, [{ seq: 10 }, { seq: 7 }, { seq: 12 }, { seq: 11 }]);

    socket.serverClose();
    mock.timers.tick(500);
    latestSocket().open();
    assert.equal(latestSocket().sent[0].last_seq, 12);
});

// --- Ready and resync ------------------------------------------------------------

test('onReady fires after every ready and last_seq follows ready.seq', () => {
    const { connection } = createConnection();
    const readies = [];
    const off = connection.onReady((info) => readies.push(info));
    connection.subscribe('Player', () => {});

    const first = goLive('e1', 5);
    mock.timers.tick(5_000);
    first.serverClose();
    mock.timers.tick(500);

    // A new epoch can restart the sequence lower; ready.seq wins.
    goLive('e2', 2);
    assert.deepEqual(readies, [{ seq: 5 }, { seq: 2 }]);

    mock.timers.tick(5_000);
    latestSocket().serverClose();
    mock.timers.tick(500);
    latestSocket().open();
    assert.deepEqual(latestSocket().sent[0], { type: 'hello', epoch: 'e2', last_seq: 2, rooms: [] });

    off();
    latestSocket().receive({ type: 'ready', epoch: 'e2', seq: 2 });
    assert.equal(readies.length, 2);
});

test('resync notifies listeners instead of reloading', () => {
    const { connection, reloads } = createConnection();
    const resyncs = [];
    connection.onResync(() => resyncs.push(true));
    connection.subscribe('Player', () => {});

    const socket = goLive('e1', 3);
    socket.receive({ type: 'resync' });
    assert.equal(resyncs.length, 1);
    assert.equal(reloads.length, 0);
});

test('resync reloads the page only when no listener is registered', () => {
    const { connection, reloads } = createConnection();
    const off = connection.onResync(() => {});
    off();
    connection.subscribe('Player', () => {});

    // With no epoch yet there's no stream position to lose, so nothing happens.
    latestSocket().open();
    latestSocket().receive({ type: 'resync' });
    assert.equal(reloads.length, 0);

    latestSocket().receive({ type: 'ready', epoch: 'e1', seq: 3 });
    latestSocket().receive({ type: 'resync' });
    assert.equal(reloads.length, 1);
});

// --- Status ----------------------------------------------------------------------

test('status goes connecting -> live -> reconnecting -> live', () => {
    const { connection } = createConnection();
    const statuses = [];
    connection.onStatus((status) => statuses.push(status));
    assert.equal(connection.getStatus(), 'connecting');

    connection.subscribe('Player', () => {});
    latestSocket().open();
    assert.equal(connection.getStatus(), 'connecting');

    latestSocket().receive({ type: 'ready', epoch: 'e1', seq: 0 });
    assert.equal(connection.getStatus(), 'live');

    latestSocket().serverClose();
    assert.equal(connection.getStatus(), 'reconnecting');
    mock.timers.tick(500);
    latestSocket().serverClose();
    assert.equal(connection.getStatus(), 'reconnecting');
    mock.timers.tick(1_000);
    goLive();

    assert.deepEqual(statuses, ['live', 'reconnecting', 'live']);
});

test('3 failed connects plus a 401 from /api/auth/me means signed-out until a wake', async () => {
    const environment = createEnvironment();
    const fetchCalls = [];
    const fetchImpl = async (url, init) => {
        fetchCalls.push({ url, init });
        return { status: 401, type: 'basic' };
    };
    const { connection } = createConnection({ environment, fetchImpl });
    connection.subscribe('Player', () => {});

    failConnects(connection, 2);
    await flushPromises();
    assert.equal(fetchCalls.length, 0);

    failConnects(connection, 1);
    await flushPromises();
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, '/api/auth/me');
    assert.equal(fetchCalls[0].init.redirect, 'manual');
    assert.equal(connection.getStatus(), 'signed-out');

    // No more retries, not even for a new subscriber.
    const socketCount = FakeWebSocket.instances.length;
    mock.timers.tick(60_000);
    connection.subscribe('GameRoom', () => {});
    assert.equal(FakeWebSocket.instances.length, socketCount);

    // A wake tries again.
    environment.window.dispatchEvent(new Event('online'));
    assert.equal(FakeWebSocket.instances.length, socketCount + 1);
    assert.equal(connection.getStatus(), 'connecting');
    goLive();
    assert.equal(connection.getStatus(), 'live');
});

test('an opaque redirect from /api/auth/me (expired Cloudflare Access) means signed-out', async () => {
    const fetchImpl = async () => ({ status: 0, type: 'opaqueredirect' });
    const { connection } = createConnection({ fetchImpl });
    connection.subscribe('Player', () => {});

    failConnects(connection, 3);
    await flushPromises();
    assert.equal(connection.getStatus(), 'signed-out');
});

test('any other auth check answer keeps reconnecting', async () => {
    const answers = [
        async () => ({ status: 200, type: 'basic' }),
        async () => ({ status: 502, type: 'basic' }),
        async () => {
            throw new TypeError('Failed to fetch');
        },
    ];

    for (const fetchImpl of answers) {
        FakeWebSocket.instances = [];
        const { connection } = createConnection({ fetchImpl });
        const unsubscribe = connection.subscribe('Player', () => {});

        failConnects(connection, 3);
        await flushPromises();
        assert.equal(connection.getStatus(), 'connecting');

        const socketCount = FakeWebSocket.instances.length;
        mock.timers.tick(reconnectDelay(2, () => 1));
        assert.equal(FakeWebSocket.instances.length, socketCount + 1);

        unsubscribe();
        connection.closeIdle();
    }
});

test('an auth check answered after ready is ignored', async () => {
    let answer;
    const fetchImpl = () => new Promise((resolve) => {
        answer = resolve;
    });
    const { connection } = createConnection({ fetchImpl });
    connection.subscribe('Player', () => {});

    failConnects(connection, 3);
    mock.timers.tick(reconnectDelay(2, () => 1));
    goLive();

    answer({ status: 401, type: 'basic' });
    await flushPromises();
    assert.equal(connection.getStatus(), 'live');
});

// --- Presence and votes ----------------------------------------------------------

test('presence messages are forwarded to presence listeners', () => {
    const { connection } = createConnection();
    const received = [];
    connection.onPresence((message) => received.push(message));
    connection.subscribe('Player', () => {});
    const socket = goLive();

    const presence = {
        type: 'presence',
        room_id: 'room-1',
        players: [{ player_id: 'p1', online: true, last_seen: null }],
    };
    socket.receive(presence);
    assert.deepEqual(received, [presence]);
});

test('vote, vote-passed and vote-error are forwarded; voteHold/voteRelease send messages', () => {
    const { connection } = createConnection();
    const received = [];
    connection.onVote((message) => received.push(message.type));
    connection.subscribe('Player', () => {});
    const socket = goLive();

    socket.receive({ type: 'vote', room_id: 'room-1', topic: 'make-host', eligible: [], holds: [], pending: null });
    socket.receive({ type: 'vote-passed', room_id: 'room-1', topic: 'make-host', option: 'p2' });
    socket.receive({ type: 'vote-error', room_id: 'room-1', topic: 'make-host', code: 'not_member' });
    assert.deepEqual(received, ['vote', 'vote-passed', 'vote-error']);

    connection.voteHold('room-1', 'make-host', 'p2');
    connection.voteRelease('room-1', 'make-host');
    assert.deepEqual(socket.sent.slice(-2), [
        { type: 'vote-hold', room_id: 'room-1', topic: 'make-host', option: 'p2' },
        { type: 'vote-release', room_id: 'room-1', topic: 'make-host' },
    ]);
});

// --- Entry status (entering-cards indicator) -------------------------------------

test('entryStatus sends an entry-status message with the state and round', () => {
    const { connection } = createConnection();
    connection.subscribe('Player', () => {});
    const socket = goLive();

    connection.entryStatus('room-1', 'scanning', 3);
    connection.entryStatus('room-1', 'typing', 3);
    connection.entryStatus('room-1', null, 3);

    assert.deepEqual(socket.sent.slice(-3), [
        { type: 'entry-status', room_id: 'room-1', state: 'scanning', round: 3 },
        { type: 'entry-status', room_id: 'room-1', state: 'typing', round: 3 },
        { type: 'entry-status', room_id: 'room-1', state: null, round: 3 },
    ]);
});

test('entryStatus sends nothing while the socket is not open', () => {
    const { connection } = createConnection();
    connection.subscribe('Player', () => {});
    const socket = latestSocket();

    connection.entryStatus('room-1', 'typing', 1);

    assert.deepEqual(socket.sent, []);
});

test('entry-status messages are forwarded to entry status listeners until they are removed', () => {
    const { connection } = createConnection();
    const received = [];
    const off = connection.onEntryStatus((message) => received.push(message));
    connection.subscribe('Player', () => {});
    const socket = goLive();

    const message = {
        type: 'entry-status',
        room_id: 'room-1',
        entries: [{ player_id: 'p2', state: 'scanning', round: 1 }],
    };
    socket.receive(message);
    assert.deepEqual(received, [message]);

    off();
    socket.receive(message);
    assert.equal(received.length, 1);
});

test('entry-status messages do not reach vote or presence listeners', () => {
    const { connection } = createConnection();
    const received = [];
    connection.onVote((message) => received.push(message));
    connection.onPresence((message) => received.push(message));
    connection.subscribe('Player', () => {});
    const socket = goLive();

    socket.receive({ type: 'entry-status', room_id: 'room-1', entries: [] });

    assert.deepEqual(received, []);
});

// --- Entities --------------------------------------------------------------------

test('entity clients build the REST requests from the contract', async () => {
    const calls = [];
    mock.method(globalThis, 'fetch', async (url, init) => {
        calls.push({ url, method: init.method, body: init.body, credentials: init.credentials });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const entities = createEntitiesProxy({ subscribe: () => () => {} });

    await entities.Player.list('-created_date', 10);
    await entities.Player.filter({ room_id: 'abc' });
    await entities.GameRoom.get('id 1');
    await entities.GameRoom.create({ code: 'X' });
    await entities.GameRoom.bulkCreate([{ code: 'Y' }]);
    await entities.RoundScore.update('r1', { score: 3 });
    await entities.RoundScore.delete('r1');

    assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
        'GET /api/entities/Player?sort=-created_date&limit=10',
        'GET /api/entities/Player?q=%7B%22room_id%22%3A%22abc%22%7D',
        'GET /api/entities/GameRoom/id%201',
        'POST /api/entities/GameRoom',
        'POST /api/entities/GameRoom/bulk',
        'PUT /api/entities/RoundScore/r1',
        'DELETE /api/entities/RoundScore/r1',
    ]);
    assert.equal(calls[3].body, '{"code":"X"}');
    assert.ok(calls.every((call) => call.credentials === 'same-origin'));
    assert.equal(entities.Player, entities.Player);
    assert.equal(entities.then, undefined);
});

test('failed requests reject with status and parsed data', async () => {
    mock.method(globalThis, 'fetch', async () => {
        return new Response(JSON.stringify({ message: 'Authentication required' }), { status: 401 });
    });
    const entities = createEntitiesProxy({ subscribe: () => () => {} });

    await assert.rejects(entities.Player.list(), (error) => {
        assert.equal(error.message, 'Authentication required');
        assert.equal(error.status, 401);
        assert.deepEqual(error.data, { message: 'Authentication required' });
        return true;
    });
});

// --- Review fixes ------------------------------------------------------------------

function authCheckFetch(status) {
    const calls = [];
    const pending = [];
    const fetchImpl = (url) => {
        calls.push(url);
        return new Promise((resolve) => {
            pending.push(() => resolve({ status, type: 'basic' }));
        });
    };
    return { fetchImpl, calls, answerAll: () => pending.forEach((answer) => answer()) };
}

test('ready followed by an immediate close keeps backing off and reaches the auth check', async () => {
    const { fetchImpl, calls } = authCheckFetch(401);
    const { connection } = createConnection({ fetchImpl });
    connection.subscribe('Player', () => {});

    goLive();
    latestSocket().serverClose();
    mock.timers.tick(500); // attempt 0
    assert.equal(FakeWebSocket.instances.length, 2);

    goLive();
    latestSocket().serverClose();
    mock.timers.tick(999); // attempt 1 waits 1000ms
    assert.equal(FakeWebSocket.instances.length, 2);
    mock.timers.tick(1);
    assert.equal(FakeWebSocket.instances.length, 3);

    goLive();
    latestSocket().serverClose();
    assert.equal(calls.length, 1);
});

test('a socket that stays ready for 5s resets the backoff', () => {
    const { connection } = createConnection();
    connection.subscribe('Player', () => {});

    goLive();
    latestSocket().serverClose();
    mock.timers.tick(500);
    goLive();
    mock.timers.tick(5_000);
    latestSocket().serverClose();
    mock.timers.tick(500);
    assert.equal(FakeWebSocket.instances.length, 3);
});

test('a fresh first subscribe after signed-out connects again', () => {
    const { connection } = createConnection();
    const off = connection.subscribe('Player', () => {});
    connection.signOut();
    assert.equal(connection.getStatus(), 'signed-out');

    off();
    mock.timers.tick(5_000);
    const socketCount = FakeWebSocket.instances.length;
    connection.subscribe('Player', () => {});
    assert.equal(FakeWebSocket.instances.length, socketCount + 1);
    assert.equal(connection.getStatus(), 'connecting');

    // Failure counting still applies to the new attempt.
    assert.equal(connection.failedConnects, 0);
    latestSocket().serverClose();
    assert.equal(connection.failedConnects, 1);
});

test('rooms-ok answering an empty or released room list does not fire onReady', () => {
    const environment = createEnvironment();
    const { connection } = createConnection({ environment });
    const readies = [];
    connection.onReady((info) => readies.push(info));
    connection.subscribe('Player', () => {});

    const socket = goLive('e1', 1);
    socket.receive({ type: 'rooms-ok', seq: 2 });
    assert.deepEqual(readies, [{ seq: 1 }]);

    connection.setRooms(['room-1']);
    environment.window.dispatchEvent(new Event('pagehide'));
    socket.receive({ type: 'rooms-ok', seq: 3 });
    assert.deepEqual(readies, [{ seq: 1 }]);

    environment.window.dispatchEvent(pageshowEvent(true));
    socket.receive({ type: 'rooms-ok', seq: 4 });
    assert.deepEqual(readies, [{ seq: 1 }, { seq: 4 }]);
});

test('a late 401 from an auth check started before a wake does not drop the new socket', async () => {
    const environment = createEnvironment();
    const { fetchImpl, answerAll } = authCheckFetch(401);
    const { connection } = createConnection({ environment, fetchImpl });
    connection.subscribe('Player', () => {});

    failConnects(connection, 3);
    environment.window.dispatchEvent(new Event('online'));
    const socket = goLive();
    answerAll();
    await flushPromises();

    assert.equal(connection.getStatus(), 'live');
    assert.equal(socket.closeCalls, 0);
});

test('a late 401 from an auth check started before a scheduled reconnect is ignored', async () => {
    const { fetchImpl, answerAll } = authCheckFetch(401);
    const { connection } = createConnection({ fetchImpl });
    connection.subscribe('Player', () => {});

    failConnects(connection, 3);
    mock.timers.tick(10_000); // the backoff timer opens a new socket
    const socket = goLive();
    answerAll();
    await flushPromises();

    assert.equal(connection.getStatus(), 'live');
    assert.equal(socket.closeCalls, 0);
});

test('setRooms sends nothing for an unchanged list or before ready', () => {
    const { connection } = createConnection();
    const readies = [];
    connection.onReady((info) => readies.push(info));
    connection.subscribe('Player', () => {});

    const socket = latestSocket();
    socket.open();
    connection.setRooms(['room-1']); // after hello, before ready
    assert.deepEqual(socket.sent.map((message) => message.type), ['hello']);

    socket.receive({ type: 'rooms-ok', seq: 1 });
    assert.deepEqual(readies, []);

    // `ready` catches the server up on the list that changed after hello.
    socket.receive({ type: 'ready', epoch: 'e1', seq: 1 });
    assert.deepEqual(socket.sent.at(-1), { type: 'rooms', rooms: ['room-1'] });

    const sentCount = socket.sent.length;
    connection.setRooms(['room-1']);
    assert.equal(socket.sent.length, sentCount);

    connection.setRooms(['room-1', 'room-2']);
    assert.deepEqual(socket.sent.at(-1), { type: 'rooms', rooms: ['room-1', 'room-2'] });
});

test('a pong timeout counts as a failed connect and reaches the auth check', async () => {
    const { fetchImpl, calls, answerAll } = authCheckFetch(401);
    const { connection } = createConnection({ fetchImpl });
    connection.subscribe('Player', () => {});
    goLive();

    mock.timers.tick(10_000); // ping sent
    connection.failedConnects = 2;
    mock.timers.tick(5_000); // no pong
    assert.equal(connection.failedConnects, 3);
    assert.equal(calls.length, 1);

    answerAll();
    await flushPromises();
    assert.equal(connection.getStatus(), 'signed-out');
});

test('rooms released by a cancelled navigation are re-sent on the next ping tick', () => {
    const environment = createEnvironment();
    const { connection } = createConnection({ environment });
    connection.setRooms(['room-1']);
    connection.subscribe('Player', () => {});
    const socket = goLive();

    environment.window.dispatchEvent(new Event('pagehide'));
    assert.deepEqual(socket.sent.at(-1), { type: 'rooms', rooms: [] });

    mock.timers.tick(10_000);
    assert.deepEqual(socket.sent.slice(-2), [{ type: 'rooms', rooms: ['room-1'] }, { type: 'ping' }]);
});

// --- Guards and edge branches (A2) ----------------------------------------------------

test('a non-JSON frame is ignored with a warning', () => {
    const { connection } = createConnection();
    connection.subscribe('Player', () => {});
    const socket = goLive();

    socket.onmessage({ data: 'not json {' });

    assert.equal(connection.getStatus(), 'live');
});

test('an unknown message type is ignored', () => {
    const { connection } = createConnection();
    connection.subscribe('Player', () => {});
    const socket = goLive();

    socket.receive({ type: 'something-new' });

    assert.equal(connection.getStatus(), 'live');
});

test('a callback unsubscribe called twice only removes the listener once', () => {
    const { connection } = createConnection();
    const calls = [];
    const first = connection.subscribe('Player', () => calls.push('first'));
    connection.subscribe('Player', () => calls.push('second'));
    const socket = goLive();

    first();
    first();
    socket.receive(eventMessage(1, 'Player', 'p1', 1));

    assert.deepEqual(calls, ['second']);
});

test('a socket that cannot be constructed schedules a retry', () => {
    class ThrowingWebSocket {
        constructor() {
            throw new Error('blocked');
        }
    }
    const connection = new RealtimeConnection({
        url: 'ws://test/api/realtime',
        WebSocketImpl: ThrowingWebSocket,
    });

    connection.subscribe('Player', () => {});

    assert.equal(connection.getStatus(), 'connecting');
    assert.equal(connection.failedConnects, 1);
    assert.notEqual(connection.reconnectTimer, null);
});

test('events from a replaced socket are ignored', () => {
    const { connection } = createConnection();
    connection.subscribe('Player', () => {});
    const staleSocket = { readyState: 1 };

    connection.handleOpen(staleSocket);
    connection.handleConnectTimeout(staleSocket);
    connection.handleClose(staleSocket);
    connection.handleMessage(staleSocket, JSON.stringify({ type: 'ready', epoch: 'e', seq: 0 }));

    assert.equal(connection.getStatus(), 'connecting');
    assert.equal(connection.socket, latestSocket());
});

test('a socket that closes after the last listener left closes idle without retrying', () => {
    const { connection } = createConnection();
    const off = connection.subscribe('Player', () => {});
    const socket = goLive();

    off();
    socket.serverClose();

    assert.equal(connection.socket, null);
    assert.equal(connection.reconnectTimer, null);
    assert.equal(FakeWebSocket.instances.length, 1);
});

test('scheduling a reconnect twice keeps the first timer', () => {
    const { connection } = createConnection();
    connection.subscribe('Player', () => {});
    latestSocket().serverClose();
    const timer = connection.reconnectTimer;

    connection.scheduleReconnect();

    assert.equal(connection.reconnectTimer, timer);
});

test('dropping a socket whose close() throws does not throw', () => {
    const { connection } = createConnection();
    connection.subscribe('Player', () => {});
    latestSocket().close = () => {
        throw new Error('already closing');
    };

    assert.doesNotThrow(() => connection.dropSocket());
    assert.equal(connection.socket, null);
});

test('the auth check does nothing without a fetch implementation', async () => {
    const { connection } = createConnection();
    connection.subscribe('Player', () => {});

    await connection.checkSignedIn();

    assert.equal(connection.getStatus(), 'connecting');
});

test('a second ping while a pong is pending sends nothing', () => {
    const { connection } = createConnection();
    connection.subscribe('Player', () => {});
    const socket = goLive();

    connection.ping();
    connection.ping();

    const pings = socket.sent.filter((message) => message.type === 'ping');
    assert.equal(pings.length, 1);
});

test('releasing rooms without an open socket does nothing', () => {
    const { connection } = createConnection();

    connection.releaseRooms();

    assert.equal(connection.areRoomsReleased, false);
});

test('waking with no listeners does nothing', () => {
    const { connection } = createConnection();

    connection.handleWake();

    assert.equal(FakeWebSocket.instances.length, 0);
});

test('closeIdle keeps the socket while a listener remains', () => {
    const { connection } = createConnection();
    connection.subscribe('Player', () => {});
    goLive();

    connection.closeIdle();

    assert.notEqual(connection.socket, null);
    assert.equal(connection.getStatus(), 'live');
});

test('a listener set unsubscribe called twice removes the entry once', () => {
    const { connection } = createConnection();
    connection.subscribe('Player', () => {});
    const listeners = connection.listenersByEntity.get('Player');
    const calls = [];
    const off = listeners.add(() => calls.push('extra'));

    off();
    off();
    listeners.emit({}, {});

    assert.deepEqual(calls, []);
});
