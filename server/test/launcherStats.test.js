import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, connectRealtime, createMessageLog, devLogin, startTestServer } from './helpers.js';

// The launcher's room stats end to end: the real hub and actions, reporting to a fake parent port.

const REPORT_DELAY_MS = 20;

describe('room stats sent to the launcher', () => {
    let server;
    let cookie;
    const port = createMessageLog();
    port.postMessage = (message) => port.push(message);
    const openClients = [];

    before(async () => {
        server = await startTestServer({ launcherPort: port, launcherReportDelayMs: REPORT_DELAY_MS });
        cookie = await devLogin(server.baseUrl, 'host@example.com', 'Host');
    });

    after(async () => {
        for (const client of openClients) {
            await client.close();
        }
        await server.stop();
    });

    function waitForStats(predicate) {
        return port.waitFor((message) => message.type === 'room-stats' && predicate(message.stats));
    }

    async function joinRealtime(roomId) {
        const client = connectRealtime(server.wsUrl, cookie, { ignoreTypes: ['vote'] });
        openClients.push(client);
        await client.opened;
        client.send({ type: 'hello', epoch: null, last_seq: null, rooms: [roomId] });
        return client;
    }

    test('nobody yet, as soon as the server listens', async () => {
        const first = await waitForStats(() => true);

        assert.deepEqual(first.stats, { playersOnline: 0, roomsLive: 0, rooms: [] });
    });

    test('follows a player joining, the game starting and the player leaving', async () => {
        const created = await api(server.baseUrl, 'POST', '/api/rooms', { cookie, body: { max_score: 150 } });
        const { room } = created.body;

        const client = await joinRealtime(room.id);
        const joined = await waitForStats((stats) => stats.roomsLive === 1);
        assert.deepEqual(joined.stats, {
            playersOnline: 1,
            roomsLive: 1,
            rooms: [{ code: room.code, status: 'waiting', round: room.current_round, maxScore: 150, online: 1, players: 1 }],
        });

        await api(server.baseUrl, 'POST', `/api/rooms/${room.id}/actions/start`, { cookie });
        const started = await waitForStats((stats) => stats.rooms[0]?.status === 'playing');
        assert.equal(started.stats.rooms[0].round, 1);

        await client.close();
        const left = await waitForStats((stats) => stats.roomsLive === 0);
        assert.equal(left.stats.playersOnline, 0);
    });
});
