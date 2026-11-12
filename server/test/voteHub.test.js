import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { openStore } from '../src/db.js';
import { createRealtimeHub } from '../src/realtime.js';
import { connectRealtime, silentLogger } from './helpers.js';

// The hub's vote handling with a stub topic, so a passed vote's action can fail.

const VOTE_HOLD_MS = 50;
const TOPIC = 'stub';

describe('vote-passed and the action result', () => {
    let dataDir;
    let store;
    let hub;
    let server;
    let wsUrl;
    let resolveStatus = 200;
    let roomId;
    const openClients = [];

    before(async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-test-'));
        store = openStore(dataDir);
        // A room with no host_email or host_player_id, so there is no host and both online players
        // must agree.
        const [room] = store.createRecords('GameRoom', [{ status: 'playing' }], null);
        roomId = room.id;
        store.createRecords('Player', [
            { room_id: roomId, email: 'ann@example.com' },
            { room_id: roomId, email: 'ben@example.com' },
        ], null);

        hub = createRealtimeHub({
            // The test passes the identity in a header instead of a session.
            authenticate: (headers) => ({ email: headers.cookie }),
            store,
            logger: silentLogger,
            voteHoldMs: VOTE_HOLD_MS,
            voteTopics: {
                [TOPIC]: {
                    validateOption: () => true,
                    resolve: () => ({ status: resolveStatus, body: { code: 'stub_failure' } }),
                },
            },
        });
        server = http.createServer();
        hub.attach(server);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        wsUrl = `ws://127.0.0.1:${server.address().port}/api/realtime`;
    });

    after(async () => {
        for (const client of openClients) {
            await client.close();
        }
        hub.close();
        await new Promise((resolve) => server.close(resolve));
        store.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    async function subscribe(email) {
        const client = connectRealtime(wsUrl, email, { ignoreTypes: ['presence'] });
        openClients.push(client);
        await client.opened;
        client.send({ type: 'hello', epoch: null, last_seq: null, rooms: [roomId] });
        await client.nextOfType('ready');
        return client;
    }

    /** Both players hold `option`; resolves with the first vote state after the pending one. */
    async function passVote(clients, option) {
        for (const client of clients) {
            client.send({ type: 'vote-hold', room_id: roomId, topic: TOPIC, option });
        }
        let message = await clients[0].next();
        while (!(message.type === 'vote' && message.pending !== null)) {
            message = await clients[0].next();
        }
        return clients[0].next();
    }

    test('a failed action sends no vote-passed; a successful one does', async () => {
        const clients = [await subscribe('ann@example.com'), await subscribe('ben@example.com')];

        resolveStatus = 409;
        const cleared = await passVote(clients, 'first');
        assert.equal(cleared.type, 'vote');
        assert.deepEqual(cleared.holds, []);
        await clients[0].expectSilence(VOTE_HOLD_MS * 2);

        resolveStatus = 200;
        await passVote(clients, 'second');
        const passed = await clients[0].next();
        assert.deepEqual(passed, { type: 'vote-passed', room_id: roomId, topic: TOPIC, option: 'second' });
    });
});
