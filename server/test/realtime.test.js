import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { openStore } from '../src/db.js';
import { createEventLog } from '../src/eventLog.js';
import { createRealtimeHub } from '../src/realtime.js';
import { api, attemptUpgrade, connectRealtime, devLogin, startTestServer } from './helpers.js';

// --- Shared helpers ------------------------------------------------------

/**
 * Connects, says hello and returns the client (ready not yet read). Vote
 * states are ignored; votes.test.js covers them.
 */
async function connectAndHello(server, cookie, hello, openClients) {
    const client = connectRealtime(server.wsUrl, cookie, { ignoreTypes: ['vote'] });
    openClients.push(client);
    await client.opened;
    client.send({ type: 'hello', epoch: null, last_seq: null, rooms: [], ...hello });
    return client;
}

async function createRecord(server, cookie, entity, body) {
    const response = await api(server.baseUrl, 'POST', `/api/entities/${entity}`, { cookie, body });
    assert.equal(response.status, 201);
    return response.body;
}

/** A GameRoom made through the generic API; returns its id. It has no code, so rooms never clash. */
async function createRoom(server, cookie) {
    const room = await createRecord(server, cookie, 'GameRoom', { status: 'waiting' });
    return room.id;
}

// The default entities plus Note, which may have no room: game records must belong to a real one.
const ENTITIES_WITH_NOTE = 'GameRoom,Player,RoundScore,ChatMessage,Note';

async function closeAll(openClients) {
    for (const client of openClients) {
        await client.close();
    }
}

// --- Basics, events and replay --------------------------------------------

describe('realtime WebSocket', () => {
    let server;
    let cookie;
    const openClients = [];
    let roomId;
    let otherRoomId;
    let alicePlayer;

    before(async () => {
        server = await startTestServer({ env: { ENTITIES: ENTITIES_WITH_NOTE } });
        cookie = await devLogin(server.baseUrl, 'alice@example.com', 'Alice');
        roomId = await createRoom(server, cookie);
        otherRoomId = await createRoom(server, cookie);
        alicePlayer = await createRecord(server, cookie, 'Player', { room_id: roomId, email: 'alice@example.com', name: 'Alice' });
    });

    after(async () => {
        await closeAll(openClients);
        await server.stop();
    });

    function hello(message) {
        return connectAndHello(server, cookie, message, openClients);
    }

    test('unauthenticated upgrade is rejected with 401', async () => {
        assert.equal(await attemptUpgrade(server.wsUrl), 401);
        assert.equal(await attemptUpgrade(server.wsUrl, { cookie: 'flip7_session=forged.value' }), 401);
    });

    test('hello is answered with ready; ping with pong', async () => {
        const client = await hello();
        const ready = await client.next();
        assert.equal(ready.type, 'ready');
        assert.equal(typeof ready.epoch, 'string');
        assert.equal(ready.seq, server.instance.hub.seq);

        client.send({ type: 'ping' });
        assert.deepEqual(await client.next(), { type: 'pong' });
        await client.close();
    });

    test('sockets that have not said hello get no live events', async () => {
        const client = connectRealtime(server.wsUrl, cookie);
        openClients.push(client);
        await client.opened;
        await createRecord(server, cookie, 'RoundScore', { room_id: roomId, player_id: alicePlayer.id });
        await client.expectSilence();
        await client.close();
    });

    test('ready is followed by presence for each room', async () => {
        const client = await hello({ rooms: [roomId] });
        assert.equal((await client.next()).type, 'ready');
        const presence = await client.next();
        assert.equal(presence.type, 'presence');
        assert.equal(presence.room_id, roomId);
        assert.equal(presence.players.length, 1);
        assert.equal(presence.players[0].online, true);
        await client.close();
    });

    test('subscribed client receives create, update and delete events', async () => {
        const client = await hello({ rooms: [roomId] });
        const ready = await client.next();

        const player = await createRecord(server, cookie, 'Player', { room_id: roomId, email: 'zed@example.com', name: 'Zed' });
        const createEvent = await client.nextOfType('event');
        assert.equal(createEvent.seq, ready.seq + 1);
        assert.equal(createEvent.entity, 'Player');
        assert.equal(createEvent.event.type, 'create');
        assert.equal(createEvent.event.id, player.id);
        assert.deepEqual(createEvent.event.data, player);
        assert.ok(createEvent.event.timestamp);
        assert.equal(createEvent.room_version, null);

        await api(server.baseUrl, 'PUT', `/api/entities/Player/${player.id}`, { cookie, body: { name: 'Zed 2' } });
        const updateEvent = await client.nextOfType('event');
        assert.equal(updateEvent.seq, ready.seq + 2);
        assert.equal(updateEvent.event.type, 'update');
        assert.equal(updateEvent.event.data.name, 'Zed 2');

        await api(server.baseUrl, 'DELETE', `/api/entities/Player/${player.id}`, { cookie });
        const deleteEvent = await client.nextOfType('event');
        assert.equal(deleteEvent.seq, ready.seq + 3);
        assert.equal(deleteEvent.event.type, 'delete');
        assert.equal(deleteEvent.event.id, player.id);
        assert.equal(deleteEvent.event.data.room_id, roomId);
        assert.equal(deleteEvent.event.data.name, 'Zed 2');

        await client.close();
    });

    test('publish carries room_version when given; a GameRoom is its own room', async () => {
        const client = await hello({ rooms: [roomId] });
        await client.nextOfType('presence');

        server.instance.hub.publish('GameRoom', 'update', { id: roomId, version: 4 }, { roomVersion: 4 });
        const event = await client.next();
        assert.equal(event.entity, 'GameRoom');
        assert.equal(event.room_version, 4);
        await client.close();
    });

    test('bulk create emits one create event per record', async () => {
        const client = await hello({ rooms: [roomId] });
        await client.nextOfType('presence');

        await api(server.baseUrl, 'POST', '/api/entities/RoundScore/bulk', {
            cookie,
            body: [
                { room_id: roomId, player_id: alicePlayer.id, score: 1 },
                { room_id: roomId, player_id: alicePlayer.id, score: 2 },
            ],
        });
        const first = await client.next();
        const second = await client.next();
        assert.deepEqual([first.event.data.score, second.event.data.score], [1, 2]);
        assert.equal(second.seq, first.seq + 1);
        await client.close();
    });

    test('events without a room are not delivered', async () => {
        const client = await hello({ rooms: [roomId] });
        await client.nextOfType('presence');
        await createRecord(server, cookie, 'Note', { score: 3 });
        await client.expectSilence();
        await client.close();
    });

    test('reconnecting replays missed events for the socket\'s rooms before ready', async () => {
        const first = await hello({ rooms: [roomId] });
        const ready = await first.next();
        await first.close();

        const missedA = await createRecord(server, cookie, 'RoundScore', { room_id: roomId, player_id: alicePlayer.id, name: 'A' });
        await createRecord(server, cookie, 'RoundScore', { room_id: otherRoomId, player_id: alicePlayer.id, name: 'skip' });
        const missedB = await createRecord(server, cookie, 'RoundScore', { room_id: roomId, player_id: alicePlayer.id, name: 'B' });

        const second = await hello({ epoch: ready.epoch, last_seq: ready.seq, rooms: [roomId] });
        const replayA = await second.next();
        const replayB = await second.next();
        const readyAgain = await second.next();

        assert.equal(replayA.event.id, missedA.id);
        assert.equal(replayA.seq, ready.seq + 1);
        assert.equal(replayB.event.id, missedB.id);
        assert.equal(replayB.seq, ready.seq + 3);
        assert.equal(readyAgain.type, 'ready');
        assert.equal(readyAgain.seq, ready.seq + 3);
        await second.close();
    });

    test('up-to-date reconnect replays nothing', async () => {
        const hub = server.instance.hub;
        const client = await hello({ epoch: hub.epoch, last_seq: hub.seq });
        const ready = await client.next();
        assert.equal(ready.type, 'ready');
        await client.close();
    });

    test('wrong epoch gets resync instead of replay', async () => {
        await createRecord(server, cookie, 'RoundScore', { room_id: roomId, player_id: alicePlayer.id });
        const client = await hello({ epoch: 'from-a-lost-database', last_seq: 0 });
        assert.deepEqual(await client.next(), { type: 'resync' });
        const ready = await client.next();
        assert.equal(ready.type, 'ready');
        assert.equal(ready.epoch, server.instance.hub.epoch);
        await client.close();
    });

    test('a last_seq ahead of the server gets resync', async () => {
        const hub = server.instance.hub;
        const client = await hello({ epoch: hub.epoch, last_seq: hub.seq + 50 });
        assert.deepEqual(await client.next(), { type: 'resync' });
        await client.close();
    });
});

// --- Room scoping ----------------------------------------------------------

describe('realtime room scoping', () => {
    let server;
    let alice;
    let bob;
    let boss;
    let alicePlayer;
    let bobPlayer;
    let roomA;
    let roomB;
    const openClients = [];

    before(async () => {
        server = await startTestServer({ env: { ADMIN_EMAILS: 'boss@example.com', ENTITIES: ENTITIES_WITH_NOTE } });
        alice = await devLogin(server.baseUrl, 'alice@example.com');
        bob = await devLogin(server.baseUrl, 'bob@example.com');
        boss = await devLogin(server.baseUrl, 'boss@example.com');
        roomA = await createRoom(server, alice);
        roomB = await createRoom(server, bob);
        alicePlayer = await createRecord(server, alice, 'Player', { room_id: roomA, email: 'alice@example.com' });
        bobPlayer = await createRecord(server, bob, 'Player', { room_id: roomB, email: 'Bob@Example.com' });
    });

    after(async () => {
        await closeAll(openClients);
        await server.stop();
    });

    async function subscribed(cookie, rooms) {
        const client = await connectAndHello(server, cookie, { rooms }, openClients);
        assert.equal((await client.next()).type, 'ready');
        for (let index = 0; index < rooms.length; index += 1) {
            assert.equal((await client.next()).type, 'presence');
        }
        return client;
    }

    test('a socket in room A never receives room B\'s events or chat', async () => {
        const aliceClient = await subscribed(alice, [roomA]);
        const bobClient = await subscribed(bob, [roomB]);

        await createRecord(server, bob, 'RoundScore', { room_id: roomB, player_id: bobPlayer.id });
        await createRecord(server, bob, 'ChatMessage', { room_id: roomB, message: 'secret' });
        server.instance.hub.publish('GameRoom', 'update', { id: roomB });

        assert.equal((await bobClient.next()).entity, 'RoundScore');
        assert.equal((await bobClient.next()).entity, 'ChatMessage');
        assert.equal((await bobClient.next()).entity, 'GameRoom');
        await aliceClient.expectSilence();

        await createRecord(server, alice, 'ChatMessage', { room_id: roomA, message: 'hi' });
        assert.equal((await aliceClient.next()).event.data.message, 'hi');
        await bobClient.expectSilence();

        await aliceClient.close();
        await bobClient.close();
    });

    test('a non-member\'s subscription is dropped', async () => {
        const client = await connectAndHello(server, alice, { rooms: [roomB, 42] }, openClients);
        assert.equal((await client.next()).type, 'ready');
        await createRecord(server, bob, 'RoundScore', { room_id: roomB, player_id: bobPlayer.id });
        await client.expectSilence();
        await client.close();
    });

    test('"*" is ignored for non-admins', async () => {
        const client = await connectAndHello(server, alice, { rooms: ['*'] }, openClients);
        assert.equal((await client.next()).type, 'ready');
        await createRecord(server, bob, 'RoundScore', { room_id: roomB, player_id: bobPlayer.id });
        await client.expectSilence();
        await client.close();
    });

    test('an admin "*" socket gets every room\'s events but not chat of rooms it isn\'t in', async () => {
        const client = await connectAndHello(server, boss, { rooms: ['*'] }, openClients);
        assert.equal((await client.next()).type, 'ready');

        await createRecord(server, bob, 'ChatMessage', { room_id: roomB, message: 'private' });
        await createRecord(server, bob, 'RoundScore', { room_id: roomB, player_id: bobPlayer.id });
        await createRecord(server, bob, 'Note', { score: 'no room' });
        assert.equal((await client.next()).entity, 'RoundScore');
        assert.equal((await client.next()).event.data.score, 'no room');
        await client.expectSilence();
        await client.close();
    });

    test('rooms replaces the list and is answered with rooms-ok, its seq, then presence for new rooms', async () => {
        const client = await subscribed(alice, []);

        client.send({ type: 'rooms', rooms: [roomA, roomB] });
        const roomsOk = await client.next();
        assert.deepEqual(roomsOk, { type: 'rooms-ok', seq: server.instance.hub.seq });
        const presence = await client.next();
        assert.equal(presence.type, 'presence');
        assert.equal(presence.room_id, roomA);

        await createRecord(server, bob, 'RoundScore', { room_id: roomB, player_id: bobPlayer.id });
        await client.expectSilence();
        await createRecord(server, alice, 'RoundScore', { room_id: roomA, player_id: alicePlayer.id });
        assert.equal((await client.next()).entity, 'RoundScore');

        client.send({ type: 'rooms', rooms: [] });
        assert.equal((await client.next()).type, 'rooms-ok');
        await createRecord(server, alice, 'RoundScore', { room_id: roomA, player_id: alicePlayer.id });
        await client.expectSilence();
        await client.close();
    });

    test('a removed player\'s socket sees the delete, then nothing more from the room', async () => {
        const client = await subscribed(bob, [roomB]);

        await api(server.baseUrl, 'DELETE', `/api/entities/Player/${bobPlayer.id}`, { cookie: alice });
        const deleteEvent = await client.next();
        assert.equal(deleteEvent.event.type, 'delete');
        assert.equal(deleteEvent.event.id, bobPlayer.id);

        await createRecord(server, alice, 'ChatMessage', { room_id: roomB, message: 'after kick' });
        await client.expectSilence();
        await client.close();
    });
});

// --- Presence ------------------------------------------------------------

describe('realtime presence', () => {
    let server;
    let alice;
    let bob;
    let alicePlayer;
    let bobPlayer;
    let clock = 1_000_000;
    const openClients = [];
    let roomId;

    before(async () => {
        server = await startTestServer({ realtimeNow: () => clock });
        alice = await devLogin(server.baseUrl, 'alice@example.com');
        bob = await devLogin(server.baseUrl, 'bob@example.com');
        roomId = await createRoom(server, alice);
        alicePlayer = await createRecord(server, alice, 'Player', { room_id: roomId, email: 'alice@example.com' });
        bobPlayer = await createRecord(server, bob, 'Player', { room_id: roomId, email: 'bob@example.com' });
    });

    after(async () => {
        await closeAll(openClients);
        await server.stop();
    });

    function onlineById(presence) {
        const online = {};
        for (const player of presence.players) {
            online[player.player_id] = player.online;
        }
        return online;
    }

    async function joinRoom(cookie) {
        const client = await connectAndHello(server, cookie, { rooms: [roomId] }, openClients);
        assert.equal((await client.next()).type, 'ready');
        const presence = await client.next();
        assert.equal(presence.type, 'presence');
        return { client, presence };
    }

    test('two sockets for one user are one online player; offline when the last closes', async () => {
        const first = await joinRoom(alice);
        assert.deepEqual(onlineById(first.presence), { [alicePlayer.id]: true, [bobPlayer.id]: false });

        const second = await joinRoom(alice);
        assert.deepEqual(onlineById(second.presence), { [alicePlayer.id]: true, [bobPlayer.id]: false });
        await first.client.expectSilence();

        const watcher = await joinRoom(bob);
        assert.deepEqual(onlineById(watcher.presence), { [alicePlayer.id]: true, [bobPlayer.id]: true });
        assert.deepEqual(onlineById(await first.client.next()), { [alicePlayer.id]: true, [bobPlayer.id]: true });

        await second.client.close();
        await watcher.client.expectSilence();

        await first.client.close();
        const offline = await watcher.client.next();
        assert.equal(offline.type, 'presence');
        assert.deepEqual(onlineById(offline), { [alicePlayer.id]: false, [bobPlayer.id]: true });

        const aliceEntry = offline.players.find((player) => player.player_id === alicePlayer.id);
        assert.equal(aliceEntry.last_seen, new Date(clock).toISOString());
        // last_seen is stored, but without an entity event.
        await watcher.client.expectSilence();
        const stored = await api(server.baseUrl, 'GET', `/api/entities/Player/${alicePlayer.id}`, { cookie: bob });
        assert.equal(stored.body.last_seen, aliceEntry.last_seen);

        await watcher.client.close();
    });

    test('a socket without a recent ping counts as offline until it pings again', async () => {
        const watcher = await joinRoom(bob);
        const aliceSocket = await joinRoom(alice);
        assert.equal(onlineById(await watcher.client.next())[alicePlayer.id], true);

        clock += 16_000;
        watcher.client.send({ type: 'ping' });
        assert.equal((await watcher.client.next()).type, 'pong');
        server.instance.hub.checkLiveness();

        const stale = await watcher.client.next();
        assert.deepEqual(onlineById(stale), { [alicePlayer.id]: false, [bobPlayer.id]: true });
        assert.equal((await aliceSocket.client.next()).type, 'presence');

        // Coming back online sends the new presence before the pong.
        aliceSocket.client.send({ type: 'ping' });
        assert.equal((await aliceSocket.client.next()).type, 'presence');
        assert.equal((await aliceSocket.client.next()).type, 'pong');
        assert.equal(onlineById(await watcher.client.next())[alicePlayer.id], true);

        await watcher.client.close();
        await aliceSocket.client.close();
    });

    test('a WebSocket pong does not count as liveness; only a client ping does', async () => {
        const watcher = await joinRoom(bob);
        const aliceSocket = await joinRoom(alice);
        assert.equal(onlineById(await watcher.client.next())[alicePlayer.id], true);

        clock += 16_000;
        watcher.client.send({ type: 'ping' });
        assert.equal((await watcher.client.next()).type, 'pong');
        aliceSocket.client.socket.pong();
        // A reply on the same socket proves the pong frame was handled first.
        aliceSocket.client.send({ type: 'vote-release' });
        assert.equal((await aliceSocket.client.next()).type, 'vote-error');
        server.instance.hub.checkLiveness();

        const stale = await watcher.client.next();
        assert.deepEqual(onlineById(stale), { [alicePlayer.id]: false, [bobPlayer.id]: true });

        await watcher.client.close();
        await aliceSocket.client.close();
    });

    test('a Player moved to another room by a generic PUT leaves the old room\'s presence', async () => {
        const elsewhere = await createRoom(server, bob);
        const watcher = await joinRoom(bob);
        const dave = await createRecord(server, bob, 'Player', { room_id: roomId, email: 'dave@example.com' });
        assert.equal((await watcher.client.next()).type, 'event');
        assert.ok(onlineById(await watcher.client.next())[dave.id] === false);

        const moved = await api(server.baseUrl, 'PUT', `/api/entities/Player/${dave.id}`, {
            cookie: bob,
            body: { room_id: elsewhere },
        });
        assert.equal(moved.status, 200);
        const presence = await watcher.client.next();
        assert.equal(presence.type, 'presence');
        assert.equal(Object.hasOwn(onlineById(presence), dave.id), false);
        await watcher.client.close();
    });

    test('a joining player triggers a presence update', async () => {
        const watcher = await joinRoom(bob);
        const carol = await createRecord(server, bob, 'Player', { room_id: roomId, email: 'carol@example.com' });

        assert.equal((await watcher.client.next()).type, 'event');
        const presence = await watcher.client.next();
        assert.equal(presence.type, 'presence');
        assert.equal(onlineById(presence)[carol.id], false);
        await watcher.client.close();
    });
});

// --- Durability and trimming -----------------------------------------------

describe('realtime event log across restarts', () => {
    test('a restart on the same DATA_DIR replays instead of resyncing', async () => {
        const openClients = [];
        const first = await startTestServer();
        const cookie = await devLogin(first.baseUrl, 'alice@example.com');
        const roomId = await createRoom(first, cookie);
        const player = await createRecord(first, cookie, 'Player', { room_id: roomId, email: 'alice@example.com' });

        const client = await connectAndHello(first, cookie, { rooms: [roomId] }, openClients);
        const ready = await client.next();
        await client.close();
        const missed = await createRecord(first, cookie, 'RoundScore', { room_id: roomId, player_id: player.id });
        await first.instance.close();

        const second = await startTestServer({ dataDir: first.dataDir });
        try {
            const reconnected = await connectAndHello(
                second,
                cookie,
                { epoch: ready.epoch, last_seq: ready.seq, rooms: [roomId] },
                openClients,
            );
            const replayed = await reconnected.next();
            assert.equal(replayed.type, 'event');
            assert.equal(replayed.event.id, missed.id);

            const readyAgain = await reconnected.next();
            assert.equal(readyAgain.type, 'ready');
            assert.equal(readyAgain.epoch, ready.epoch);
            assert.equal(readyAgain.seq, ready.seq + 1);
            await reconnected.close();
        } finally {
            await second.stop();
        }
        assert.equal(fs.existsSync(first.dataDir), false);
    });
});

describe('realtime event log trimming', () => {
    let server;
    let cookie;
    const openClients = [];
    let roomId;

    before(async () => {
        server = await startTestServer({ eventLogLimit: 10 });
        cookie = await devLogin(server.baseUrl, 'bob@example.com');
        // Straight into the store, so the room publishes no event and the counts below hold.
        const [room] = server.instance.store.createRecords('GameRoom', [{ status: 'waiting' }], 'bob@example.com');
        roomId = room.id;
        await createRecord(server, cookie, 'Player', { room_id: roomId, email: 'bob@example.com' });
    });

    after(async () => {
        await closeAll(openClients);
        await server.stop();
    });

    test('only the newest events are kept, and an older gap gets resync', async () => {
        const hub = server.instance.hub;
        const eventLog = server.instance.store.eventLog;
        for (let index = 0; index < 15; index += 1) {
            hub.publish('RoundScore', 'create', { id: `fake-${index}`, room_id: roomId });
        }

        // 16 events in total (the Player create plus 15), so seq 7..16 remain.
        assert.equal(hub.seq, 16);
        assert.equal(eventLog.readAfter(0, null).length, 10);
        assert.equal(eventLog.oldestSeq(), 7);

        const replayed = await connectAndHello(server, cookie, { epoch: hub.epoch, last_seq: 6, rooms: [roomId] }, openClients);
        assert.equal((await replayed.next()).seq, 7);
        await replayed.close();

        const tooOld = await connectAndHello(server, cookie, { epoch: hub.epoch, last_seq: 5, rooms: [roomId] }, openClients);
        assert.deepEqual(await tooOld.next(), { type: 'resync' });
        assert.equal((await tooOld.next()).type, 'ready');
        await tooOld.close();
    });

    test('publishAll stores a batch with consecutive seqs and one room_version', () => {
        const hub = server.instance.hub;
        const before = hub.seq;
        hub.publishAll([
            { entity: 'RoundScore', type: 'create', record: { id: 'batch-1', room_id: roomId } },
            { entity: 'GameRoom', type: 'update', record: { id: roomId } },
        ], { roomVersion: 3 });

        const rows = server.instance.store.eventLog.readAfter(before, null);
        assert.deepEqual(rows.map((row) => row.seq), [before + 1, before + 2]);
        assert.equal(JSON.parse(rows[1].text).room_version, 3);
    });
});

describe('realtime event log limits', () => {
    test('an event limit below 1 is rejected', () => {
        const db = new Database(':memory:');
        try {
            assert.throws(() => createEventLog(db, { maxEvents: 0 }), /maxEvents must be an integer >= 1/);
        } finally {
            db.close();
        }
    });
});

// --- Socket errors (X14) ---------------------------------------------------

function makeResetError() {
    const error = new Error('read ECONNRESET');
    error.code = 'ECONNRESET';
    return error;
}

/** Resolves with the next raw socket the HTTP server hands to its 'upgrade' listeners. */
function nextUpgradeSocket(httpServer) {
    return new Promise((resolve) => {
        httpServer.prependOnceListener('upgrade', (request, socket) => resolve(socket));
    });
}

/** Sends a WebSocket upgrade request (no session cookie) over a raw TCP socket. */
function sendRawUpgrade(wsUrl) {
    const { hostname, port, pathname } = new URL(wsUrl);
    const client = net.connect(Number(port), hostname);
    client.on('error', () => {
        // The server may close first; only the server side matters here.
    });
    client.write(
        `GET ${pathname} HTTP/1.1\r\n`
        + `Host: ${hostname}:${port}\r\n`
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
        + 'Sec-WebSocket-Version: 13\r\n'
        + '\r\n',
    );
    return client;
}

async function assertServerAnswers(server) {
    const response = await api(server.baseUrl, 'GET', '/api/health');
    assert.equal(response.status, 200);
}

describe('realtime socket errors', () => {
    let server;
    let cookie;

    before(async () => {
        server = await startTestServer();
        cookie = await devLogin(server.baseUrl, 'erin@example.com');
    });

    after(async () => {
        await server.stop();
    });

    test('a reset on a rejected upgrade socket does not crash the server', async () => {
        const upgradeSocket = nextUpgradeSocket(server.instance.server);
        const client = sendRawUpgrade(server.wsUrl);
        const serverSocket = await upgradeSocket;

        // An 'error' with no listener throws, which in production is an uncaught exception.
        assert.doesNotThrow(() => serverSocket.emit('error', makeResetError()));
        client.resetAndDestroy();
        await assertServerAnswers(server);
    });

    test('a client resetting its upgrade mid-way leaves the server answering', async () => {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            sendRawUpgrade(server.wsUrl).resetAndDestroy();
        }
        await assertServerAnswers(server);
        assert.equal(await attemptUpgrade(server.wsUrl), 401);
    });

    test('a reset on an accepted socket does not crash the server', async () => {
        const upgradeSocket = nextUpgradeSocket(server.instance.server);
        const client = connectRealtime(server.wsUrl, cookie);
        const serverSocket = await upgradeSocket;
        await client.opened;

        assert.doesNotThrow(() => serverSocket.emit('error', makeResetError()));
        await client.close();
        await assertServerAnswers(server);
    });
});

// --- Malformed input and leftovers (B8) ------------------------------------

describe('realtime malformed client input', () => {
    let server;
    let cookie;
    const openClients = [];

    before(async () => {
        server = await startTestServer();
        cookie = await devLogin(server.baseUrl, 'fay@example.com', 'Fay');
    });

    after(async () => {
        await closeAll(openClients);
        await server.stop();
    });

    async function readyClient() {
        const client = await connectAndHello(server, cookie, {}, openClients);
        await client.nextOfType('ready');
        return client;
    }

    test('invalid JSON, unknown types and non-object messages are ignored; the socket keeps working', async () => {
        const client = await readyClient();

        client.socket.send('this is not json');
        client.socket.send('null');
        client.socket.send('42');
        client.send({ type: 'no-such-type' });
        client.send({});
        client.send({ type: 'ping' });

        assert.deepEqual(await client.nextOfType('pong'), { type: 'pong' });
    });

    test('rooms before hello is ignored, and a vote-release before hello is refused as not_member', async () => {
        const client = connectRealtime(server.wsUrl, cookie, { ignoreTypes: ['vote'] });
        openClients.push(client);
        await client.opened;

        client.send({ type: 'rooms', rooms: ['x'] });
        client.send({ type: 'vote-release', room_id: 'x', topic: 'make-host' });
        assert.equal((await client.next()).code, 'not_member');

        client.send({ type: 'ping' });
        assert.deepEqual(await client.next(), { type: 'pong' });
    });

    test('a hello with a non-string epoch or a non-integer last_seq is treated as fresh', async () => {
        const epoch = server.instance.hub.epoch;
        for (const hello of [{ epoch: 5, last_seq: 1 }, { epoch, last_seq: 'x' }, { epoch, last_seq: 1.5 }]) {
            const client = await connectAndHello(server, cookie, hello, openClients);
            const ready = await client.next();
            assert.equal(ready.type, 'ready');
        }
    });

    test('a message above the size limit closes the socket with 1009 and the server survives', async () => {
        const client = await readyClient();
        const closed = new Promise((resolve) => client.socket.once('close', resolve));
        client.socket.send('x'.repeat(20 * 1024));
        assert.equal(await closed, 1009);
        await assertServerAnswers(server);
    });

    test('a vote-release for an unknown topic is answered with vote-error', async () => {
        const client = connectRealtime(server.wsUrl, cookie);
        openClients.push(client);
        await client.opened;
        client.send({ type: 'vote-release', room_id: 'nope', topic: 'nope' });
        const error = await client.nextOfType('vote-error');
        assert.equal(error.code, 'unknown_topic');
    });

    test('upgrade requests for other paths or with an unparseable URL are dropped', async () => {
        for (const requestPath of ['/api/other', '//[']) {
            const client = net.connect(Number(new URL(server.wsUrl).port), '127.0.0.1');
            client.on('error', () => {});
            client.write(
                `GET ${requestPath} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
                + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
            );
            await new Promise((resolve) => client.once('close', resolve));
        }
        await assertServerAnswers(server);
    });
});

describe('realtime votes that go stale', () => {
    let server;
    const openClients = [];

    before(async () => {
        server = await startTestServer({ voteHoldMs: 300 });
    });

    after(async () => {
        await closeAll(openClients);
        await server.stop();
    });

    test('a vote whose option disappears while held does not pass', async () => {
        const hostCookie = await devLogin(server.baseUrl, 'host2@example.com', 'Host');
        const annCookie = await devLogin(server.baseUrl, 'ann2@example.com', 'Ann');
        const created = await api(server.baseUrl, 'POST', '/api/rooms', { cookie: hostCookie, body: { max_score: 200 } });
        const roomId = created.body.room.id;
        const joined = await api(server.baseUrl, 'POST', `/api/rooms/${roomId}/actions/join`, { cookie: annCookie, body: { name: 'ann' } });
        const annId = joined.body.player.id;

        const clients = [];
        for (const userCookie of [hostCookie, annCookie]) {
            const client = await connectAndHello(server, userCookie, { rooms: [roomId] }, openClients);
            await client.nextOfType('ready');
            clients.push(client);
        }
        for (const client of clients) {
            client.send({ type: 'vote-hold', room_id: roomId, topic: 'make-host', option: annId });
        }

        // The option is removed behind the vote's back (a generic delete does not cancel votes).
        const removal = await api(server.baseUrl, 'DELETE', `/api/entities/Player/${annId}`, { cookie: annCookie });
        assert.ok(removal.status < 300, `delete answered ${removal.status}`);

        await new Promise((resolve) => setTimeout(resolve, 600));
        for (const client of clients) {
            assert.ok(!client.log.messages.some((message) => message.type === 'vote-passed'));
        }
        const room = server.instance.store.getRecord('GameRoom', roomId);
        assert.equal(room.host_email, 'host2@example.com');
    });
});

describe('realtime hub with a fake socket layer', () => {
    let dataDir;
    let store;
    let httpServer;
    let hub;
    let logs;
    let authenticate;

    beforeEach(async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-hub-'));
        store = openStore(dataDir);
        logs = { warn: [], error: [] };
        authenticate = async () => ({ email: 'zed@example.com' });
        const logger = {
            log() {},
            info() {},
            warn: (text) => logs.warn.push(text),
            error: (text) => logs.error.push(text),
        };
        hub = createRealtimeHub({
            authenticate: (headers) => authenticate(headers),
            store,
            isAdmin: () => {
                throw new Error('admin lookup broke');
            },
            logger,
            heartbeatIntervalMs: 40,
        });
        httpServer = http.createServer();
        hub.attach(httpServer);
        await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    });

    afterEach(async () => {
        hub.close();
        await new Promise((resolve) => httpServer.close(resolve));
        store.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    function fakeUpgradeSocket(overrides = {}) {
        return {
            destroyed: false,
            destroyCalls: 0,
            on() {},
            off() {},
            end() {},
            destroy() {
                this.destroyed = true;
                this.destroyCalls += 1;
            },
            ...overrides,
        };
    }

    function emitUpgrade(socket) {
        httpServer.emit('upgrade', { url: '/api/realtime', headers: {} }, socket, Buffer.alloc(0));
        return new Promise((resolve) => setImmediate(resolve));
    }

    test('an authenticator that throws is logged and answered with 401', async () => {
        authenticate = async () => {
            throw new Error('auth backend down');
        };
        let written = '';
        const socket = fakeUpgradeSocket({
            end: (text) => {
                written = text;
            },
        });
        await emitUpgrade(socket);
        assert.equal(logs.error.length, 1);
        assert.match(written, /401/);
    });

    test('a socket destroyed while auth was pending is left alone', async () => {
        const socket = fakeUpgradeSocket({ destroyed: true });
        await emitUpgrade(socket);
        assert.equal(logs.error.length, 0);
        assert.equal(socket.destroyCalls, 0);
    });

    test('a failure while rejecting an upgrade is logged and destroys the socket', async () => {
        authenticate = async () => null;
        const socket = fakeUpgradeSocket({
            end() {
                throw new Error('socket already gone');
            },
        });
        await emitUpgrade(socket);
        assert.deepEqual(logs.error, ['Realtime upgrade failed']);
        assert.equal(socket.destroyCalls, 1);
    });

    test('a handler that throws is logged instead of crashing, and the socket stays usable', async () => {
        const client = connectRealtime(`ws://127.0.0.1:${httpServer.address().port}/api/realtime`, 'x=y', { ignoreTypes: ['vote'] });
        await client.opened;
        client.send({ type: 'hello', epoch: null, last_seq: null, rooms: ['*'] });
        await client.expectSilence();
        assert.deepEqual(logs.error, ['Realtime message failed']);

        client.send({ type: 'ping' });
        assert.deepEqual(await client.next(), { type: 'pong' });
        await client.close();
    });

    test('the heartbeat terminates a socket that never answers pings', async () => {
        // A raw client completes the handshake but never reads, so it never pongs.
        const { port } = httpServer.address();
        const raw = net.connect(port, '127.0.0.1');
        raw.on('error', () => {});
        raw.resume();
        raw.write(
            'GET /api/realtime HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
            + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        );
        const closed = new Promise((resolve) => raw.once('close', resolve));
        await Promise.race([
            closed,
            new Promise((_, reject) => setTimeout(() => reject(new Error('socket was never terminated')), 2000)),
        ]);
    });
});
