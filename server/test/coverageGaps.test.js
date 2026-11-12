import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createChild, deleteChild, listPlayers, runRoomAction, updateChild } from '../src/gameActions/roomTx.js';
import { advanceRound } from '../src/gameActions/rounds.js';
import { createVoteTopics } from '../src/gameActions/voteTopics.js';
import { api, devLogin, startTestServer } from './helpers.js';

// Branch coverage for the remaining server gaps (test plan W5.5): the
// start-up script, the error handler, entity body guards, the room
// transaction's event queue and a few action validations.

const SERVER_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// --- index.js ------------------------------------------------------------

function findFreePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

/** Resolves once the child's stdout contains `text`. */
function waitForOutput(child, text) {
    return new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${text}": ${output}`)), 15000);
        child.stdout.on('data', (chunk) => {
            output += chunk;
            if (output.includes(text)) {
                clearTimeout(timer);
                resolve(output);
            }
        });
        child.once('exit', () => {
            clearTimeout(timer);
            reject(new Error(`Exited before "${text}": ${output}`));
        });
    });
}

describe('index.js start-up', () => {
    let dataDir;

    before(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-index-'));
    });

    after(() => {
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    test('listens, serves /api/health and shuts down cleanly', async () => {
        const port = await findFreePort();
        // SIGTERM cannot be delivered on Windows, so this preload turns any stdin
        // input into the same shutdown handler.
        const preload = path.join(dataDir, 'shutdown-on-stdin.cjs');
        fs.writeFileSync(preload, "process.stdin.on('data', () => { process.emit('SIGTERM'); process.emit('SIGTERM'); });");
        const child = spawn(process.execPath, ['--require', preload, 'src/index.js'], {
            cwd: SERVER_DIR,
            env: {
                ...process.env,
                DATA_DIR: dataDir,
                PORT: String(port),
                AUTH_MODE: 'dev',
                ADMIN_EMAILS: 'boss@example.com',
                DEV_ALLOW_ADMINS: '',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let errorOutput = '';
        child.stderr.on('data', (chunk) => {
            errorOutput += chunk;
        });
        const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));

        try {
            const output = await waitForOutput(child, 'listening');
            assert.match(output, /AUTH_MODE=dev/);

            const health = await fetch(`http://127.0.0.1:${port}/api/health`);
            assert.deepEqual(await health.json(), { ok: true });

            // Two signals at once: the second must be ignored while shutting down.
            child.stdin.write('stop\n');
            assert.equal(await exited, 0);

            // ADMIN_EMAILS without the opt-in is dropped in dev mode, and says so (X89).
            assert.match(errorOutput, /ADMIN_EMAILS is ignored in AUTH_MODE=dev/);
        } finally {
            child.kill('SIGKILL');
        }
    });
});

// --- app.js, entities.js -------------------------------------------------

describe('app and entity edges', () => {
    let server;
    let baseUrl;
    let cookie;

    before(async () => {
        server = await startTestServer();
        baseUrl = server.baseUrl;
        cookie = await devLogin(baseUrl, 'edge@example.com', 'Edge');
    });

    after(async () => {
        await server.stop();
    });

    test('an unknown /api path answers 404 JSON once signed in', async () => {
        const response = await api(baseUrl, 'GET', '/api/nope', { cookie });
        assert.equal(response.status, 404);
        assert.deepEqual(response.body, { message: 'Not found' });
    });

    test('an error after the response started ends the response', async () => {
        const { app } = server.instance;
        app.use((req, res, next) => {
            res.write('partial');
            next(new Error('late failure'));
        });
        // Move the probe to the front so it sees the request before the real routes.
        const layers = app.router.stack;
        layers.unshift(layers.pop());

        try {
            const response = await fetch(`${baseUrl}/api/health`);
            assert.equal(await response.text(), 'partial');
        } finally {
            layers.shift();
        }
    });

    test('a HEAD request for a client route is served index.html', async () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-static-'));
        fs.writeFileSync(path.join(dataDir, 'index.html'), '<html></html>');
        const config = loadConfig({
            AUTH_MODE: 'dev',
            SESSION_SECRET: 'test-secret',
            DATA_DIR: dataDir,
            STATIC_DIR: dataDir,
        });
        // No logger option, so the app falls back to the console.
        const instance = createServer(config);
        await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));

        try {
            const url = `http://127.0.0.1:${instance.server.address().port}/some/route`;
            const response = await fetch(url, { method: 'HEAD' });
            assert.equal(response.status, 200);
        } finally {
            await instance.close();
            fs.rmSync(dataDir, { recursive: true, force: true });
        }
    });

    test('a malformed list query is answered 400', async () => {
        const response = await api(baseUrl, 'GET', '/api/entities/GameRoom?q=notjson', { cookie });
        assert.equal(response.status, 400);
    });

    test('an update body that is not an object is answered 400', async () => {
        const created = await api(baseUrl, 'POST', '/api/entities/GameRoom', { cookie, body: { code: 'ABCD' } });
        assert.equal(created.status, 201);

        const response = await api(baseUrl, 'PUT', `/api/entities/GameRoom/${created.body.id}`, {
            cookie,
            body: [1],
        });
        assert.equal(response.status, 400);
    });
});

describe('entity store failures', () => {
    let server;
    let cookie;

    before(async () => {
        server = await startTestServer();
        cookie = await devLogin(server.baseUrl, 'edge@example.com', 'Edge');
    });

    after(async () => {
        await server.stop();
    });

    test('a store failure that is not a refused write still answers 500', async () => {
        const store = server.instance.store;
        const original = store.createRecords;
        store.createRecords = () => {
            throw new Error('disk on fire');
        };

        try {
            const response = await api(server.baseUrl, 'POST', '/api/entities/GameRoom', { cookie, body: {} });
            assert.equal(response.status, 500);
            assert.deepEqual(response.body, { message: 'Internal server error' });
        } finally {
            store.createRecords = original;
        }
    });
});

describe('entity body guards under LOCK_GAME_ENTITIES', () => {
    let server;
    let baseUrl;
    let cookie;

    before(async () => {
        server = await startTestServer({ env: { LOCK_GAME_ENTITIES: 'true' } });
        baseUrl = server.baseUrl;
        cookie = await devLogin(baseUrl, 'ann@example.com', 'Ann');
    });

    after(async () => {
        await server.stop();
    });

    test('a malformed list query passes the guard and is answered 400', async () => {
        const response = await api(baseUrl, 'GET', '/api/entities/Player?q=notjson', { cookie });
        assert.equal(response.status, 400);
    });

    test('a chat message body that is not an object is answered 400', async () => {
        const response = await api(baseUrl, 'POST', '/api/entities/ChatMessage', { cookie, body: [1] });
        assert.equal(response.status, 400);
    });

    test('a bulk chat body that is not an array of objects is answered 400', async () => {
        const response = await api(baseUrl, 'POST', '/api/entities/ChatMessage/bulk', { cookie, body: { a: 1 } });
        assert.equal(response.status, 400);
    });
});

// --- Round, scoring and vote-topic edges ---------------------------------

describe('action edges', () => {
    let server;
    let baseUrl;
    let hostCookie;
    let annCookie;

    before(async () => {
        server = await startTestServer();
        baseUrl = server.baseUrl;
        hostCookie = await devLogin(baseUrl, 'host@example.com', 'host');
        annCookie = await devLogin(baseUrl, 'ann@example.com', 'ann');
    });

    after(async () => {
        await server.stop();
    });

    function action(roomId, name, body = {}, cookie = hostCookie) {
        return api(baseUrl, 'POST', `/api/rooms/${roomId}/actions/${name}`, { cookie, body });
    }

    async function waitingRoom() {
        const created = await api(baseUrl, 'POST', '/api/rooms', { cookie: hostCookie, body: { max_score: 200 } });
        const roomId = created.body.room.id;
        const joined = await action(roomId, 'join', { name: 'ann' }, annCookie);
        assert.equal(joined.status, 200);
        return roomId;
    }

    async function playingRoom() {
        const roomId = await waitingRoom();
        assert.equal((await action(roomId, 'start')).status, 200);
        return roomId;
    }

    function runDirect(roomId, body, logger = { error() {} }) {
        const context = {
            store: server.instance.store,
            hub: server.instance.hub,
            config: { adminEmails: new Set() },
            logger,
        };
        const request = {
            user: { email: 'host@example.com' },
            roomId,
            access: 'signed_in',
            allowedStatuses: null,
        };
        return runRoomAction(context, request, body);
    }

    /** Runs `body` with hub.publishAll recorded; returns the published events. */
    function publishedBy(roomId, body) {
        const published = [];
        const original = server.instance.hub.publishAll;
        server.instance.hub.publishAll = (events) => published.push(...events);

        try {
            runDirect(roomId, body);
        } finally {
            server.instance.hub.publishAll = original;
        }
        return published;
    }

    test('the next round starts with the first player when the turn holder is gone', async () => {
        const roomId = await playingRoom();
        server.instance.store.updateRecord('GameRoom', roomId, { current_turn_player_id: 'ghost' });

        const forced = await action(roomId, 'force-next-round', { round_number: 1 });
        assert.equal(forced.status, 200);
        const first = forced.body.players.find((player) => player.turn_order === 0);
        assert.equal(forced.body.room.current_turn_player_id, first.id);
    });

    test('wins that are not an object are rejected', async () => {
        const roomId = await playingRoom();
        const response = await action(roomId, 'set-games-won', { wins: [1] });
        assert.equal(response.status, 400);
    });

    test('rooms and players saved without optional fields fall back to defaults', async () => {
        const room = await api(baseUrl, 'POST', '/api/entities/GameRoom', {
            cookie: hostCookie,
            body: { code: 'ZZZZ', status: 'playing', host_email: 'host@example.com', max_score: 10 },
        });
        const roomId = room.body.id;
        for (const total of [20, 5]) {
            await api(baseUrl, 'POST', '/api/entities/Player', {
                cookie: hostCookie,
                body: { room_id: roomId, email: `scored-${total}@example.com`, total_score: total },
            });
        }

        const result = runDirect(roomId, (tx) => {
            advanceRound(tx);
        });
        assert.equal(result.status, 200);
        assert.equal(result.body.room.status, 'finished');
        assert.equal(result.body.players.find((player) => player.total_score === 20).games_won, 1);
    });

    test('a write the store refuses inside an action answers its status and rolls the action back', async () => {
        const roomId = await waitingRoom();

        const result = runDirect(roomId, (tx) => {
            createChild(tx, 'ChatMessage', { room_id: tx.room.id, message: 'never sent' });
            // ann joined in waitingRoom, so a second Player for her breaks one-player-per-user.
            createChild(tx, 'Player', { room_id: tx.room.id, email: 'ann@example.com', name: 'ann again' });
        });

        assert.equal(result.status, 409);
        assert.equal(result.body.code, 'conflict');
        assert.deepEqual(server.instance.store.findRecords('ChatMessage', 'room_id', roomId), []);
    });

    test('ending a game with no players finishes it without a winner', async () => {
        const room = await api(baseUrl, 'POST', '/api/entities/GameRoom', {
            cookie: hostCookie,
            body: { code: 'YYYY', status: 'playing', host_email: 'host@example.com', max_score: 10 },
        });

        const ended = await action(room.body.id, 'end-game');
        assert.equal(ended.status, 200);
        assert.equal(ended.body.room.winner_player_id, null);
    });

    test('edit-score without a player_id is rejected', async () => {
        const roomId = await playingRoom();
        const response = await action(roomId, 'edit-score', { round_number: 1 });
        assert.equal(response.status, 400);
    });

    test('set-games-won rejects a negative or non-integer value', async () => {
        const roomId = await playingRoom();
        const response = await action(roomId, 'set-games-won', { wins: { someone: -1 } });
        assert.equal(response.status, 400);
    });

    test('make-host votes are only valid for a live room and a non-host member', () => {
        const topic = createVoteTopics({})['make-host'];
        const players = [{ id: 'p1', email: 'a@example.com' }];
        assert.equal(topic.validateOption(null, players, 'p1'), false);
        assert.equal(topic.validateOption({ status: 'closed', host_email: 'x' }, players, 'p1'), false);
    });

    test('deleting a record updated earlier in the action queues a delete', async () => {
        const roomId = await waitingRoom();
        const published = publishedBy(roomId, (tx) => {
            const ann = listPlayers(tx).find((player) => player.email === 'ann@example.com');
            updateChild(tx, 'Player', ann, { name: 'renamed' });
            deleteChild(tx, 'Player', ann);
            // The record is already gone, so a second delete queues nothing.
            deleteChild(tx, 'Player', ann);
        });

        const playerEvents = published.filter((event) => event.entity === 'Player');
        assert.deepEqual(playerEvents.map((event) => event.type), ['delete']);
    });

    test('a record created and deleted in one action publishes nothing', async () => {
        const roomId = await waitingRoom();
        const published = publishedBy(roomId, (tx) => {
            const temp = createChild(tx, 'ChatMessage', { room_id: roomId, text: 'hi' });
            deleteChild(tx, 'ChatMessage', temp);
        });

        assert.deepEqual(published.filter((event) => event.entity === 'ChatMessage'), []);
    });

    test('a failure refreshing realtime state is logged, not thrown', async () => {
        const roomId = await waitingRoom();
        const errors = [];
        const original = server.instance.hub.roomMembershipChanged;
        server.instance.hub.roomMembershipChanged = () => {
            throw new Error('refresh failed');
        };

        try {
            const result = runDirect(
                roomId,
                (tx) => {
                    const ann = listPlayers(tx).find((player) => player.email === 'ann@example.com');
                    deleteChild(tx, 'Player', ann);
                },
                { error: (message) => errors.push(message) },
            );
            assert.equal(result.status, 200);
        } finally {
            server.instance.hub.roomMembershipChanged = original;
        }
        assert.equal(errors.length, 1);
        assert.match(errors[0], /Refreshing realtime state/);
    });
});
