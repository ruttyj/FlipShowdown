import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, connectRealtime, devLogin, startTestServer } from './helpers.js';

// The stale-room sweep (X81): rooms nobody has touched for STALE_ROOM_HOURS are deleted with their
// players, scores and chat, unless one of their players is online.

const HOUR_MS = 60 * 60 * 1000;

/** A clock the test moves: `clock.now()` is real time plus `clock.offsetMs`. */
function createClock() {
    const clock = {
        offsetMs: 0,
        now: () => Date.now() + clock.offsetMs,
    };
    return clock;
}

/** Polls `check` until it returns true, failing after `timeoutMs`. */
async function waitUntil(check, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) {
            throw new Error('timed out waiting for the condition');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

describe('stale room sweep', () => {
    const clock = createClock();
    let server;
    let cookie;
    const openClients = [];

    before(async () => {
        server = await startTestServer({ roomSweepNow: clock.now });
        cookie = await devLogin(server.baseUrl, 'host@example.com', 'Host');
    });

    after(async () => {
        for (const client of openClients) {
            await client.close();
        }
        await server.stop();
    });

    async function createRoom() {
        const response = await api(server.baseUrl, 'POST', '/api/rooms', { cookie, body: { max_score: 200 } });
        assert.equal(response.status, 200);
        return response.body;
    }

    function exists(entity, id) {
        return server.instance.store.getRecord(entity, id) !== null;
    }

    test('deletes a room idle for over 24 hours, with its players, scores and chat', async () => {
        clock.offsetMs = 0;
        const { room, players } = await createRoom();
        const [chat] = server.instance.store.createRecords('ChatMessage', [{ room_id: room.id, sender_id: players[0].id }], null);
        const [score] = server.instance.store.createRecords('RoundScore', [{ room_id: room.id, player_id: players[0].id }], null);

        clock.offsetMs = 25 * HOUR_MS;
        const deleted = server.instance.sweepStaleRooms();

        assert.deepEqual(deleted, [room.id]);
        assert.equal(exists('GameRoom', room.id), false);
        assert.equal(exists('Player', players[0].id), false);
        assert.equal(exists('ChatMessage', chat.id), false);
        assert.equal(exists('RoundScore', score.id), false);
    });

    test('keeps a room with recent activity', async () => {
        clock.offsetMs = 0;
        const { room } = await createRoom();

        clock.offsetMs = 23 * HOUR_MS;

        assert.deepEqual(server.instance.sweepStaleRooms(), []);
        assert.equal(exists('GameRoom', room.id), true);
    });

    test('a room with no activity yet is judged by when it was created', () => {
        clock.offsetMs = 0;
        const [room] = server.instance.store.createRecords('GameRoom', [{ code: 'OLDONE', status: 'waiting' }], null);

        clock.offsetMs = 25 * HOUR_MS;

        assert.ok(server.instance.sweepStaleRooms().includes(room.id));
        assert.equal(exists('GameRoom', room.id), false);
    });

    test('keeps a stale room while one of its players is online', async () => {
        clock.offsetMs = 0;
        const { room } = await createRoom();
        const client = connectRealtime(server.wsUrl, cookie, { ignoreTypes: ['vote'] });
        openClients.push(client);
        await client.opened;
        client.send({ type: 'hello', epoch: null, last_seq: null, rooms: [room.id] });
        let presence = await client.nextOfType('presence');
        while (!presence.players.some((player) => player.online)) {
            presence = await client.nextOfType('presence');
        }

        clock.offsetMs = 25 * HOUR_MS;

        assert.deepEqual(server.instance.sweepStaleRooms(), []);
        assert.equal(exists('GameRoom', room.id), true);
    });

    test('a room that fails to delete does not stop the others', async () => {
        clock.offsetMs = 0;
        const first = await createRoom();
        const second = await createRoom();
        const store = server.instance.store;
        const workingGetRecord = store.getRecord;
        store.getRecord = (entityName, id) => {
            if (id === first.room.id) {
                throw new Error('broken room');
            }
            return workingGetRecord.call(store, entityName, id);
        };

        clock.offsetMs = 25 * HOUR_MS;
        let deleted;
        try {
            deleted = server.instance.sweepStaleRooms();
        } finally {
            store.getRecord = workingGetRecord;
        }

        assert.ok(deleted.includes(second.room.id));
        assert.ok(!deleted.includes(first.room.id));
        assert.equal(exists('GameRoom', first.room.id), true);
    });
});

describe('stale room sweep timing and settings', () => {
    test('runs when the server starts listening', async () => {
        const first = await startTestServer();
        const cookie = await devLogin(first.baseUrl, 'host@example.com', 'Host');
        const created = await api(first.baseUrl, 'POST', '/api/rooms', { cookie, body: { max_score: 200 } });
        await first.instance.close();

        const restarted = await startTestServer({
            dataDir: first.dataDir,
            roomSweepNow: () => Date.now() + 25 * HOUR_MS,
        });
        try {
            await waitUntil(() => restarted.instance.store.getRecord('GameRoom', created.body.room.id) === null);
        } finally {
            await restarted.stop();
        }
    });

    test('STALE_ROOM_HOURS=0 turns the sweep off', async () => {
        const server = await startTestServer({
            env: { STALE_ROOM_HOURS: '0' },
            roomSweepNow: () => Date.now() + 1000 * HOUR_MS,
        });
        try {
            const cookie = await devLogin(server.baseUrl, 'host@example.com', 'Host');
            const created = await api(server.baseUrl, 'POST', '/api/rooms', { cookie, body: { max_score: 200 } });

            assert.deepEqual(server.instance.sweepStaleRooms(), []);
            assert.notEqual(server.instance.store.getRecord('GameRoom', created.body.room.id), null);
        } finally {
            await server.stop();
        }
    });
});
