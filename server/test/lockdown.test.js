import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { api, devLogin, startTestServer } from './helpers.js';

const NAMES = ['host', 'ann', 'outsider', 'boss'];

function encodeQuery(filter) {
    return encodeURIComponent(JSON.stringify(filter));
}

async function loginAll(baseUrl) {
    const cookies = {};
    for (const name of NAMES) {
        cookies[name] = await devLogin(baseUrl, `${name}@example.com`, name);
    }
    return cookies;
}

/** Creates a room for host with ann joined. Returns { roomId, code, players: { host, ann } }. */
async function createRoomWithAnn(baseUrl, cookies) {
    const created = await api(baseUrl, 'POST', '/api/rooms', { cookie: cookies.host, body: { max_score: 200 } });
    assert.equal(created.status, 200);
    const roomId = created.body.room.id;

    const joined = await api(baseUrl, 'POST', `/api/rooms/${roomId}/actions/join`, {
        cookie: cookies.ann,
        body: { name: 'ann' },
    });
    assert.equal(joined.status, 200);

    const byEmail = (email) => joined.body.players.find((player) => player.email === email);
    return {
        roomId,
        code: created.body.room.code,
        players: { host: byEmail('host@example.com'), ann: byEmail('ann@example.com') },
    };
}

function assertForbidden(response) {
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'forbidden');
    assert.equal(typeof response.body.message, 'string');
}

describe('LOCK_GAME_ENTITIES on', () => {
    let server;
    let baseUrl;
    let cookies;
    let room;
    let annMessageId;

    before(async () => {
        server = await startTestServer({
            env: { LOCK_GAME_ENTITIES: 'true', ADMIN_EMAILS: 'boss@example.com' },
        });
        baseUrl = server.baseUrl;
        cookies = await loginAll(baseUrl);
        room = await createRoomWithAnn(baseUrl, cookies);

        // The admin seeds a message from ann; the lock never applies to admins.
        const seeded = await api(baseUrl, 'POST', '/api/entities/ChatMessage', {
            cookie: cookies.boss,
            body: { room_id: room.roomId, sender_id: room.players.ann.id, text: 'hi' },
        });
        assert.equal(seeded.status, 201);
        annMessageId = seeded.body.id;
    });

    after(async () => {
        await server.stop();
    });

    function call(who, method, urlPath, body) {
        return api(baseUrl, method, `/api/entities/${urlPath}`, { cookie: cookies[who], body });
    }

    /** Fields for a record of `entity` in the shared room that the store accepts. `tag` keeps Players distinct. */
    function validFields(entity, tag) {
        if (entity === 'Player') {
            return { room_id: room.roomId, email: `${tag}@example.com` };
        }
        if (entity === 'RoundScore') {
            return { room_id: room.roomId, player_id: room.players.ann.id };
        }
        return { room_id: room.roomId };
    }

    // --- Writes ----------------------------------------------------------

    for (const entity of ['GameRoom', 'Player', 'RoundScore']) {
        test(`${entity} writes are forbidden for members and outsiders`, async () => {
            for (const who of ['ann', 'outsider']) {
                assertForbidden(await call(who, 'POST', entity, { room_id: room.roomId }));
                assertForbidden(await call(who, 'POST', `${entity}/bulk`, [{ room_id: room.roomId }]));
                assertForbidden(await call(who, 'PUT', `${entity}/some-id`, { room_id: room.roomId }));
                assertForbidden(await call(who, 'DELETE', `${entity}/some-id`));
            }
        });

        test(`${entity} writes work for an admin`, async () => {
            const created = await call('boss', 'POST', entity, { ...validFields(entity, 'admin-made'), note: 'x' });
            assert.equal(created.status, 201);

            const updated = await call('boss', 'PUT', `${entity}/${created.body.id}`, { note: 'y' });
            assert.equal(updated.status, 200);

            const bulk = await call('boss', 'POST', `${entity}/bulk`, [validFields(entity, 'admin-bulk')]);
            assert.equal(bulk.status, 201);

            const removed = await call('boss', 'DELETE', `${entity}/${created.body.id}`);
            assert.equal(removed.status, 200);

            // Leave the shared room as the other tests expect it.
            const removedBulk = await call('boss', 'DELETE', `${entity}/${bulk.body[0].id}`);
            assert.equal(removedBulk.status, 200);
        });
    }

    // --- ChatMessage writes ----------------------------------------------

    test('a member can post a chat message as their own Player', async () => {
        const response = await call('ann', 'POST', 'ChatMessage', {
            room_id: room.roomId,
            sender_id: room.players.ann.id,
            text: 'hello',
        });
        assert.equal(response.status, 201);
    });

    test('a chat message is refused for an outsider, a wrong sender or a wrong room', async () => {
        const asOutsider = await call('outsider', 'POST', 'ChatMessage', {
            room_id: room.roomId,
            sender_id: room.players.ann.id,
        });
        assertForbidden(asOutsider);

        const asOtherPlayer = await call('ann', 'POST', 'ChatMessage', {
            room_id: room.roomId,
            sender_id: room.players.host.id,
        });
        assertForbidden(asOtherPlayer);

        const otherRoom = await call('ann', 'POST', 'ChatMessage', {
            room_id: 'not-my-room',
            sender_id: room.players.ann.id,
        });
        assertForbidden(otherRoom);
    });

    test('bulk chat messages need every message to pass', async () => {
        const good = { room_id: room.roomId, sender_id: room.players.ann.id };
        const bad = { room_id: room.roomId, sender_id: room.players.host.id };

        assertForbidden(await call('ann', 'POST', 'ChatMessage/bulk', [good, bad]));
        assert.equal((await call('ann', 'POST', 'ChatMessage/bulk', [good, good])).status, 201);
        assertForbidden(await call('outsider', 'POST', 'ChatMessage/bulk', [good]));
    });

    test('chat message update and delete are forbidden except for an admin', async () => {
        for (const who of ['ann', 'outsider']) {
            assertForbidden(await call(who, 'PUT', `ChatMessage/${annMessageId}`, { text: 'edit' }));
            assertForbidden(await call(who, 'DELETE', `ChatMessage/${annMessageId}`));
        }
        assert.equal((await call('boss', 'PUT', `ChatMessage/${annMessageId}`, { text: 'edit' })).status, 200);
    });

    // --- Reads -----------------------------------------------------------

    for (const entity of ['Player', 'RoundScore', 'ChatMessage']) {
        test(`${entity} list must name a room the caller belongs to`, async () => {
            const byRoom = `${entity}?q=${encodeQuery({ room_id: room.roomId })}`;
            assert.equal((await call('ann', 'GET', byRoom)).status, 200);
            assertForbidden(await call('outsider', 'GET', byRoom));
            assert.equal((await call('boss', 'GET', byRoom)).status, 200);

            assertForbidden(await call('ann', 'GET', entity));
            assertForbidden(await call('ann', 'GET', `${entity}?q=${encodeQuery({ room_id: { $ne: 'x' } })}`));
            assertForbidden(await call('ann', 'GET', `${entity}?q=${encodeQuery({ room_id: 'other' })}`));
            assert.equal((await call('boss', 'GET', entity)).status, 200);
        });
    }

    test('Player, RoundScore and ChatMessage get-by-id need membership of the record room', async () => {
        const messageId = `ChatMessage/${annMessageId}`;
        assert.equal((await call('ann', 'GET', messageId)).status, 200);
        assertForbidden(await call('outsider', 'GET', messageId));
        assert.equal((await call('boss', 'GET', messageId)).status, 200);

        const playerId = `Player/${room.players.host.id}`;
        assert.equal((await call('ann', 'GET', playerId)).status, 200);
        assertForbidden(await call('outsider', 'GET', playerId));

        const missing = await call('ann', 'GET', 'RoundScore/nope');
        assert.equal(missing.status, 404);
    });

    test('GameRoom reads need membership, by id, code or GET /:id', async () => {
        const byId = `GameRoom?q=${encodeQuery({ id: room.roomId })}`;
        const byCode = `GameRoom?q=${encodeQuery({ code: room.code })}`;

        for (const query of [byId, byCode]) {
            const asMember = await call('ann', 'GET', query);
            assert.equal(asMember.status, 200);
            assert.equal(asMember.body.length, 1);
            assertForbidden(await call('outsider', 'GET', query));
            assert.equal((await call('boss', 'GET', query)).status, 200);
        }

        assert.equal((await call('ann', 'GET', `GameRoom/${room.roomId}`)).status, 200);
        assertForbidden(await call('outsider', 'GET', `GameRoom/${room.roomId}`));
        assert.equal((await call('boss', 'GET', `GameRoom/${room.roomId}`)).status, 200);

        assertForbidden(await call('ann', 'GET', 'GameRoom'));
        assertForbidden(await call('ann', 'GET', `GameRoom?q=${encodeQuery({ status: 'waiting' })}`));
        assertForbidden(await call('ann', 'GET', `GameRoom?q=${encodeQuery({ code: 'NOPE00' })}`));
        assert.equal((await call('boss', 'GET', 'GameRoom')).status, 200);
    });

    test('game actions still work: join, start and submit-score', async () => {
        const created = await createRoomWithAnn(baseUrl, cookies);
        const action = (who, name, body = {}) =>
            api(baseUrl, 'POST', `/api/rooms/${created.roomId}/actions/${name}`, { cookie: cookies[who], body });

        assert.equal((await action('host', 'start')).status, 200);

        const submitted = await action('ann', 'submit-score', {
            round_number: 1,
            cards: [{ value: '5', type: 'number' }],
            base_sum: 5,
            final_score: 5,
        });
        assert.equal(submitted.status, 200);

        const scores = await call('ann', 'GET', `RoundScore?q=${encodeQuery({ room_id: created.roomId })}`);
        assert.equal(scores.status, 200);
        assert.equal(scores.body.length, 1);
    });
});

describe('LOCK_GAME_ENTITIES off', () => {
    let server;
    let baseUrl;
    let cookies;

    before(async () => {
        server = await startTestServer({ env: { ADMIN_EMAILS: 'boss@example.com' } });
        baseUrl = server.baseUrl;
        cookies = await loginAll(baseUrl);
    });

    after(async () => {
        await server.stop();
    });

    test('regular users can still write and read generically', async () => {
        const created = await api(baseUrl, 'POST', '/api/entities/GameRoom', {
            cookie: cookies.outsider,
            body: { code: 'ABC234' },
        });
        assert.equal(created.status, 201);

        const listed = await api(baseUrl, 'GET', '/api/entities/Player', { cookie: cookies.outsider });
        assert.equal(listed.status, 200);

        const removed = await api(baseUrl, 'DELETE', `/api/entities/GameRoom/${created.body.id}`, {
            cookie: cookies.outsider,
        });
        assert.equal(removed.status, 200);
    });

    test('LOCK_GAME_ENTITIES accepts "1" as on', async () => {
        const lockedServer = await startTestServer({ env: { LOCK_GAME_ENTITIES: '1' } });
        try {
            const cookie = await devLogin(lockedServer.baseUrl, 'x@example.com', 'x');
            const response = await api(lockedServer.baseUrl, 'POST', '/api/entities/Player', {
                cookie,
                body: {},
            });
            assertForbidden(response);
        } finally {
            await lockedServer.stop();
        }
    });

    test('LOCK_GAME_ENTITIES is on when unset', () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-lock-'));
        try {
            assert.equal(loadConfig({ DATA_DIR: dataDir }).lockGameEntities, true);
            assert.equal(loadConfig({ DATA_DIR: dataDir, LOCK_GAME_ENTITIES: 'false' }).lockGameEntities, false);
        } finally {
            fs.rmSync(dataDir, { recursive: true, force: true });
        }
    });
});
