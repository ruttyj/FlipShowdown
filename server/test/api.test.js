import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { safeRedirectTarget } from '../src/authRoutes.js';
import { api, devLogin, startTestServer } from './helpers.js';

const ID_PATTERN = /^[0-9a-f]{24}$/;

describe('dev mode HTTP API', () => {
    let server;
    let baseUrl;
    let cookie;

    before(async () => {
        server = await startTestServer({ env: { ADMIN_EMAILS: 'Boss@Example.com' } });
        baseUrl = server.baseUrl;
        cookie = await devLogin(baseUrl, 'alice@example.com', 'Alice');
    });

    after(async () => {
        await server.stop();
    });

    /** A GameRoom made through the generic API. It has no code, so rooms never clash. */
    async function createRoom() {
        const response = await api(baseUrl, 'POST', '/api/entities/GameRoom', { cookie, body: { status: 'waiting' } });
        assert.equal(response.status, 201);
        return response.body;
    }

    async function createPlayer(room, email) {
        const response = await api(baseUrl, 'POST', '/api/entities/Player', { cookie, body: { room_id: room.id, email } });
        assert.equal(response.status, 201);
        return response.body;
    }

    // --- Health and auth -------------------------------------------------

    test('health needs no auth', async () => {
        const response = await api(baseUrl, 'GET', '/api/health');
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, { ok: true });
    });

    test('API routes return 401 without a session', async () => {
        for (const urlPath of ['/api/auth/me', '/api/entities/Player', '/api/does-not-exist']) {
            const response = await api(baseUrl, 'GET', urlPath);
            assert.equal(response.status, 401, urlPath);
            assert.deepEqual(response.body, { message: 'Authentication required' });
        }
    });

    test('a forged or tampered session cookie is rejected', async () => {
        const [name, value] = cookie.split('=');
        const tampered = `${name}=${value.slice(0, -2)}xx`;
        const response = await api(baseUrl, 'GET', '/api/auth/me', { cookie: tampered });
        assert.equal(response.status, 401);
    });

    test('GET /login renders the form with from_url escaped', async () => {
        const response = await fetch(`${baseUrl}/login?from_url=${encodeURIComponent('/x"><script>')}`);
        const html = await response.text();
        assert.equal(response.status, 200);
        assert.match(html, /<form method="post" action="\/login">/);
        assert.ok(html.includes('/x&quot;&gt;&lt;script&gt;'));
        assert.ok(!html.includes('<script>'));
    });

    test('POST /login sets an httpOnly cookie and redirects to a same-origin from_url', async () => {
        const response = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            redirect: 'manual',
            body: new URLSearchParams({ email: 'bob@example.com', from_url: '/room/abc?x=1' }),
        });
        assert.equal(response.status, 303);
        assert.equal(response.headers.get('location'), '/room/abc?x=1');

        const setCookie = response.headers.get('set-cookie');
        assert.match(setCookie, /^flip7_session=/);
        assert.match(setCookie, /HttpOnly/i);
        assert.match(setCookie, /SameSite=Lax/i);
    });

    test('POST /login turns an absolute same-origin from_url into a path', async () => {
        const response = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            redirect: 'manual',
            body: new URLSearchParams({ email: 'bob@example.com', from_url: `${baseUrl}/game?id=1` }),
        });
        assert.equal(response.headers.get('location'), '/game?id=1');
    });

    test('POST /login ignores an off-site from_url', async () => {
        for (const fromUrl of ['https://evil.example.com/', '//evil.example.com', '/\\evil.example.com']) {
            const response = await fetch(`${baseUrl}/login`, {
                method: 'POST',
                redirect: 'manual',
                body: new URLSearchParams({ email: 'bob@example.com', from_url: fromUrl }),
            });
            assert.equal(response.status, 303);
            assert.equal(response.headers.get('location'), '/', fromUrl);
        }
    });

    test('POST /login with an invalid email re-renders the form with 400', async () => {
        const response = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            redirect: 'manual',
            body: new URLSearchParams({ email: 'not-an-email' }),
        });
        assert.equal(response.status, 400);
        assert.equal(response.headers.get('set-cookie'), null);
        assert.match(await response.text(), /valid email/);
    });

    test('GET /api/auth/me returns the user', async () => {
        const response = await api(baseUrl, 'GET', '/api/auth/me', { cookie });
        assert.equal(response.status, 200);
        assert.equal(response.body.email, 'alice@example.com');
        assert.equal(response.body.full_name, 'Alice');
        assert.equal(response.body.role, 'user');
        assert.match(response.body.id, ID_PATTERN);
        assert.ok(response.body.created_date);
        assert.ok(response.body.updated_date);
    });

    test('ADMIN_EMAILS grants the admin role (case-insensitive)', async () => {
        const adminCookie = await devLogin(baseUrl, 'boss@example.com');
        const response = await api(baseUrl, 'GET', '/api/auth/me', { cookie: adminCookie });
        assert.equal(response.body.role, 'admin');
        assert.equal(response.body.full_name, null);
    });

    test('POST /login works for any email through a tunnel, including admins', async () => {
        for (const email of ['boss@example.com', 'bob@example.com']) {
            const response = await fetch(`${baseUrl}/login`, {
                method: 'POST',
                redirect: 'manual',
                headers: { 'cf-ray': '8f00000000000000-LHR' },
                body: new URLSearchParams({ email }),
            });
            assert.equal(response.status, 303, email);
            assert.match(response.headers.get('set-cookie'), /^flip7_session=/);
        }
    });

    test('PUT /api/auth/me only changes full_name', async () => {
        const response = await api(baseUrl, 'PUT', '/api/auth/me', {
            cookie,
            body: { full_name: '  Alice Cooper ', email: 'hijack@example.com', role: 'admin' },
        });
        assert.equal(response.status, 200);
        assert.equal(response.body.full_name, 'Alice Cooper');
        assert.equal(response.body.email, 'alice@example.com');
        assert.equal(response.body.role, 'user');

        const bad = await api(baseUrl, 'PUT', '/api/auth/me', { cookie, body: { full_name: 42 } });
        assert.equal(bad.status, 400);
    });

    test('POST /api/auth/logout clears the cookie in dev mode', async () => {
        const response = await api(baseUrl, 'POST', '/api/auth/logout', { cookie });
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, { logout_url: null });
        assert.match(response.headers.get('set-cookie'), /flip7_session=;/);
    });

    // --- Entities --------------------------------------------------------

    test('create / get / update (merge) / delete', async () => {
        const created = await api(baseUrl, 'POST', '/api/entities/GameRoom', {
            cookie,
            body: { name: 'Room 1', status: 'waiting', settings: { target: 200 } },
        });
        assert.equal(created.status, 201);
        assert.match(created.body.id, ID_PATTERN);
        assert.equal(created.body.created_by, 'alice@example.com');
        assert.equal(created.body.name, 'Room 1');
        assert.equal(created.body.created_date, created.body.updated_date);

        const id = created.body.id;
        const fetched = await api(baseUrl, 'GET', `/api/entities/GameRoom/${id}`, { cookie });
        assert.equal(fetched.status, 200);
        assert.deepEqual(fetched.body, created.body);

        await new Promise((resolve) => setTimeout(resolve, 5));
        const updated = await api(baseUrl, 'PUT', `/api/entities/GameRoom/${id}`, {
            cookie,
            body: { status: 'playing', round: 1 },
        });
        assert.equal(updated.status, 200);
        assert.equal(updated.body.name, 'Room 1');
        assert.equal(updated.body.status, 'playing');
        assert.equal(updated.body.round, 1);
        assert.deepEqual(updated.body.settings, { target: 200 });
        assert.equal(updated.body.created_date, created.body.created_date);
        assert.ok(updated.body.updated_date > created.body.updated_date);

        const deleted = await api(baseUrl, 'DELETE', `/api/entities/GameRoom/${id}`, { cookie });
        assert.equal(deleted.status, 200);
        assert.deepEqual(deleted.body, { success: true });

        const missing = await api(baseUrl, 'GET', `/api/entities/GameRoom/${id}`, { cookie });
        assert.equal(missing.status, 404);
        assert.ok(missing.body.message);

        const updateMissing = await api(baseUrl, 'PUT', `/api/entities/GameRoom/${id}`, { cookie, body: {} });
        assert.equal(updateMissing.status, 404);
        const deleteMissing = await api(baseUrl, 'DELETE', `/api/entities/GameRoom/${id}`, { cookie });
        assert.equal(deleteMissing.status, 404);
    });

    test('server-managed fields cannot be set or overridden by the client', async () => {
        const forged = {
            id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
            created_date: '2000-01-01T00:00:00.000Z',
            updated_date: '2000-01-01T00:00:00.000Z',
            created_by: 'mallory@example.com',
            score: 5,
        };
        const room = await createRoom();
        const player = await createPlayer(room, 'scorer@example.com');
        const created = await api(baseUrl, 'POST', '/api/entities/RoundScore', {
            cookie,
            body: { ...forged, room_id: room.id, player_id: player.id },
        });
        assert.notEqual(created.body.id, forged.id);
        assert.notEqual(created.body.created_date, forged.created_date);
        assert.equal(created.body.created_by, 'alice@example.com');
        assert.equal(created.body.score, 5);

        const updated = await api(baseUrl, 'PUT', `/api/entities/RoundScore/${created.body.id}`, {
            cookie,
            body: forged,
        });
        assert.equal(updated.body.id, created.body.id);
        assert.equal(updated.body.created_date, created.body.created_date);
        assert.notEqual(updated.body.updated_date, forged.updated_date);
        assert.equal(updated.body.created_by, 'alice@example.com');
    });

    test('filter by equality, including id and nested values', async () => {
        const room1 = await createRoom();
        const room2 = await createRoom();
        const bulk = await api(baseUrl, 'POST', '/api/entities/Player/bulk', {
            cookie,
            body: [
                { room_id: room1.id, email: 'a@example.com', name: 'A', total: 10, tags: ['x'] },
                { room_id: room1.id, email: 'b@example.com', name: 'B', total: 30, tags: ['y'] },
                { room_id: room2.id, email: 'c@example.com', name: 'C', total: 20, tags: ['x'] },
            ],
        });
        assert.equal(bulk.status, 201);
        assert.equal(bulk.body.length, 3);

        const inRoom = await api(baseUrl, 'GET', `/api/entities/Player?q=${encodeURIComponent(JSON.stringify({ room_id: room1.id }))}`, {
            cookie,
        });
        assert.deepEqual(inRoom.body.map((player) => player.name).sort(), ['A', 'B']);

        const byId = await api(baseUrl, 'GET', `/api/entities/Player?q=${encodeURIComponent(JSON.stringify({ id: bulk.body[2].id }))}`, {
            cookie,
        });
        assert.deepEqual(byId.body.map((player) => player.name), ['C']);

        const byArray = await api(baseUrl, 'GET', `/api/entities/Player?q=${encodeURIComponent(JSON.stringify({ tags: ['x'], room_id: room1.id }))}`, {
            cookie,
        });
        assert.deepEqual(byArray.body.map((player) => player.name), ['A']);

        const none = await api(baseUrl, 'GET', `/api/entities/Player?q=${encodeURIComponent('{"room_id":"nope"}')}`, {
            cookie,
        });
        assert.deepEqual(none.body, []);

        const badJson = await api(baseUrl, 'GET', '/api/entities/Player?q=%7Bnot-json', { cookie });
        assert.equal(badJson.status, 400);
        const notObject = await api(baseUrl, 'GET', `/api/entities/Player?q=${encodeURIComponent('[1]')}`, { cookie });
        assert.equal(notObject.status, 400);
    });

    test('sort asc/desc, default newest first, limit and skip', async () => {
        const room = await createRoom();
        const q = `q=${encodeURIComponent(JSON.stringify({ room_id: room.id }))}`;
        const totals = [5, 1, 3, 1];
        for (const [index, total] of totals.entries()) {
            const body = { room_id: room.id, email: `sorter${index}@example.com`, total };
            await api(baseUrl, 'POST', '/api/entities/Player', { cookie, body });
        }

        const ascending = await api(baseUrl, 'GET', `/api/entities/Player?${q}&sort=total`, { cookie });
        assert.deepEqual(ascending.body.map((player) => player.total), [1, 1, 3, 5]);

        const descending = await api(baseUrl, 'GET', `/api/entities/Player?${q}&sort=-total`, { cookie });
        assert.deepEqual(descending.body.map((player) => player.total), [5, 3, 1, 1]);

        // Default "-created_date": newest first, even within the same millisecond.
        const byDefault = await api(baseUrl, 'GET', `/api/entities/Player?${q}`, { cookie });
        assert.deepEqual(byDefault.body.map((player) => player.total), [1, 3, 1, 5]);

        const oldestFirst = await api(baseUrl, 'GET', `/api/entities/Player?${q}&sort=created_date`, { cookie });
        assert.deepEqual(oldestFirst.body.map((player) => player.total), [5, 1, 3, 1]);

        const paged = await api(baseUrl, 'GET', `/api/entities/Player?${q}&sort=-total&limit=2&skip=1`, { cookie });
        assert.deepEqual(paged.body.map((player) => player.total), [3, 1]);

        const limited = await api(baseUrl, 'GET', `/api/entities/Player?${q}&sort=total&limit=1`, { cookie });
        assert.equal(limited.body.length, 1);

        const badLimit = await api(baseUrl, 'GET', `/api/entities/Player?${q}&limit=-1`, { cookie });
        assert.equal(badLimit.status, 400);
    });

    test('a Player in an unknown room is a 400 invalid_record', async () => {
        const response = await api(baseUrl, 'POST', '/api/entities/Player', {
            cookie,
            body: { room_id: 'no-such-room', email: 'ghost@example.com' },
        });

        assert.equal(response.status, 400);
        assert.equal(response.body.code, 'invalid_record');
        assert.ok(response.body.message);
    });

    test('the same user twice in one room is a 409 conflict', async () => {
        const room = await createRoom();
        await createPlayer(room, 'twice@example.com');

        const response = await api(baseUrl, 'POST', '/api/entities/Player', {
            cookie,
            body: { room_id: room.id, email: 'Twice@Example.com' },
        });

        assert.equal(response.status, 409);
        assert.equal(response.body.code, 'conflict');
    });

    test('a bulk create with one bad item is a 400 and creates nothing', async () => {
        const room = await createRoom();

        const response = await api(baseUrl, 'POST', '/api/entities/Player/bulk', {
            cookie,
            body: [
                { room_id: room.id, email: 'first@example.com' },
                { room_id: room.id, email: 'second@example.com', total_score: 'ten' },
            ],
        });

        assert.equal(response.status, 400);
        assert.equal(response.body.code, 'invalid_record');
        const listed = await api(baseUrl, 'GET', `/api/entities/Player?q=${encodeURIComponent(JSON.stringify({ room_id: room.id }))}`, {
            cookie,
        });
        assert.deepEqual(listed.body, []);
    });

    test('an update with a value of the wrong type is a 400 and changes nothing', async () => {
        const room = await createRoom();

        const response = await api(baseUrl, 'PUT', `/api/entities/GameRoom/${room.id}`, { cookie, body: { max_score: 'high' } });

        assert.equal(response.status, 400);
        assert.equal(response.body.code, 'invalid_record');
        const fetched = await api(baseUrl, 'GET', `/api/entities/GameRoom/${room.id}`, { cookie });
        assert.deepEqual(fetched.body, room);
    });

    test('unknown entity returns 404', async () => {
        const list = await api(baseUrl, 'GET', '/api/entities/Secret', { cookie });
        assert.equal(list.status, 404);
        assert.ok(list.body.message);

        const create = await api(baseUrl, 'POST', '/api/entities/Secret', { cookie, body: { a: 1 } });
        assert.equal(create.status, 404);
    });

    test('bad bodies return 400', async () => {
        const invalidJson = await api(baseUrl, 'POST', '/api/entities/Player', { cookie, body: '{oops' });
        assert.equal(invalidJson.status, 400);
        assert.deepEqual(invalidJson.body, { message: 'Invalid JSON body' });

        const arrayBody = await api(baseUrl, 'POST', '/api/entities/Player', { cookie, body: [{ a: 1 }] });
        assert.equal(arrayBody.status, 400);

        const bulkNotArray = await api(baseUrl, 'POST', '/api/entities/Player/bulk', { cookie, body: { a: 1 } });
        assert.equal(bulkNotArray.status, 400);

        const bulkWithNull = await api(baseUrl, 'POST', '/api/entities/Player/bulk', { cookie, body: [{ a: 1 }, null] });
        assert.equal(bulkWithNull.status, 400);
    });

    test('bulk create with an empty array returns an empty array', async () => {
        const response = await api(baseUrl, 'POST', '/api/entities/RoundScore/bulk', { cookie, body: [] });
        assert.equal(response.status, 201);
        assert.deepEqual(response.body, []);
    });
});

describe('safeRedirectTarget', () => {
    const origin = 'https://flip7.example.com';

    test('keeps local paths and same-origin URLs', () => {
        assert.equal(safeRedirectTarget('/room/1?a=b#c', origin), '/room/1?a=b#c');
        assert.equal(safeRedirectTarget('https://flip7.example.com/x?y=1', origin), '/x?y=1');
    });

    test('falls back to "/" for anything else', () => {
        const unsafe = [
            undefined,
            '',
            'room/1',
            '//evil.com',
            '/\\evil.com',
            'https://evil.com/',
            'http://flip7.example.com/', // different scheme = different origin
            'javascript:alert(1)',
            '/\tjavascript',
        ];
        for (const value of unsafe) {
            assert.equal(safeRedirectTarget(value, origin), '/', String(value));
        }
    });
});
