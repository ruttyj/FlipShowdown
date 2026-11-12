import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { api, devLogin, silentLogger, startTestServer } from './helpers.js';

const ADMIN_EMAIL = 'admin@example.com';

// --- Query parsing over HTTP ---------------------------------------------

describe('entity list query errors', () => {
    let server;
    let cookie;

    before(async () => {
        server = await startTestServer();
        cookie = await devLogin(server.baseUrl, 'alice@example.com', 'Alice');
    });

    after(() => server.stop());

    test('bad q, limit and skip return a 400 JSON message', async () => {
        const queries = ['q=%7Boops', 'q=%5B1%5D', 'limit=-1', 'limit=1.5', 'skip=abc', 'q=%7B%7D&q=%7B%7D'];
        for (const query of queries) {
            const response = await api(server.baseUrl, 'GET', `/api/entities/GameRoom?${query}`, { cookie });
            assert.equal(response.status, 400, query);
            assert.equal(typeof response.body.message, 'string', query);
        }
    });
});

// --- Request body edges --------------------------------------------------

describe('room request bodies', () => {
    let server;
    let cookie;
    let roomId;

    before(async () => {
        server = await startTestServer({ env: { ADMIN_EMAILS: ADMIN_EMAIL } });
        cookie = await devLogin(server.baseUrl, 'alice@example.com', 'Alice');
        const created = await api(server.baseUrl, 'POST', '/api/rooms', { cookie, body: { max_score: 20 } });
        assert.equal(created.status, 200, JSON.stringify(created.body));
        roomId = created.body.player.room_id;
    });

    after(() => server.stop());

    test('array bodies to create and to an action are 400 bad_request', async () => {
        const create = await api(server.baseUrl, 'POST', '/api/rooms', { cookie, body: [1] });
        assert.equal(create.status, 400);
        assert.equal(create.body.code, 'bad_request');

        const action = await api(server.baseUrl, 'POST', `/api/rooms/${roomId}/actions/join`, { cookie, body: [] });
        assert.equal(action.status, 400);
        assert.equal(action.body.code, 'bad_request');
    });

    test('string, number and null JSON bodies get a 400 JSON error', async () => {
        for (const body of ['"text"', '42', 'null']) {
            const create = await api(server.baseUrl, 'POST', '/api/rooms', { cookie, body });
            assert.equal(create.status, 400, body);
            assert.equal(typeof create.body, 'object', body);
            assert.equal(create.body.message, 'Invalid JSON body', body);

            const action = await api(server.baseUrl, 'POST', `/api/rooms/${roomId}/actions/join`, { cookie, body });
            assert.equal(action.status, 400, body);
            assert.equal(action.body.message, 'Invalid JSON body', body);
        }
    });

    test('a missing body is treated as {}', async () => {
        const missing = await api(server.baseUrl, 'POST', '/api/rooms', { cookie });
        const empty = await api(server.baseUrl, 'POST', '/api/rooms', { cookie, body: {} });
        assert.equal(missing.status, empty.status);
        assert.deepEqual(missing.body, empty.body);

        const action = await api(server.baseUrl, 'POST', `/api/rooms/${roomId}/actions/join`, { cookie });
        assert.notEqual(action.status, 500);
        assert.notEqual(action.body.code, 'bad_request');
    });

    test('invalid JSON is a 400 JSON response', async () => {
        const response = await api(server.baseUrl, 'POST', '/api/rooms', { cookie, body: '{broken' });
        assert.equal(response.status, 400);
        assert.deepEqual(response.body, { message: 'Invalid JSON body' });
    });

    test('an unknown room id is 404 room_not_found', async () => {
        const response = await api(server.baseUrl, 'POST', '/api/rooms/nope/actions/join', { cookie, body: {} });
        assert.equal(response.status, 404);
        assert.equal(response.body.code, 'room_not_found');
    });

    test('an unknown action name is 404', async () => {
        const response = await api(server.baseUrl, 'POST', `/api/rooms/${roomId}/actions/__proto__`, {
            cookie,
            body: {},
        });
        assert.equal(response.status, 404);
    });
});

describe('admin cleanup removed', () => {
    let server;
    let adminCookie;

    before(async () => {
        server = await startTestServer({ env: { ADMIN_EMAILS: ADMIN_EMAIL } });
        adminCookie = await devLogin(server.baseUrl, ADMIN_EMAIL, 'Admin');
    });

    after(() => server.stop());

    test('POST /api/admin/cleanup is gone, even for an admin', async () => {
        const response = await api(server.baseUrl, 'POST', '/api/admin/cleanup', {
            cookie: adminCookie,
            body: { room_ids: [] },
        });
        assert.equal(response.status, 404);
    });
});

// --- X8: STATIC_DIR inside a dotted folder -------------------------------

describe('static frontend inside a dotted folder', () => {
    let server;
    let tempRoot;

    before(async () => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-dotted-'));
        const staticDir = path.join(tempRoot, '.dotted', 'dist');
        fs.mkdirSync(path.join(staticDir, 'assets'), { recursive: true });
        fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><div id="root"></div>');
        fs.writeFileSync(path.join(staticDir, 'assets', 'app-1.js'), 'console.log(1)');
        fs.writeFileSync(path.join(staticDir, '.secret'), 'hidden');
        server = await startTestServer({ env: { STATIC_DIR: staticDir } });
    });

    after(async () => {
        await server.stop();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('the SPA fallback and assets are served', async () => {
        const page = await fetch(`${server.baseUrl}/some/route`);
        assert.equal(page.status, 200);
        assert.match(await page.text(), /id="root"/);

        const asset = await fetch(`${server.baseUrl}/assets/app-1.js`);
        assert.equal(asset.status, 200);
    });

    test('dotfiles inside the static dir are not served as files', async () => {
        const response = await fetch(`${server.baseUrl}/.secret`);
        assert.doesNotMatch(await response.text(), /hidden/);
    });
});

// --- Static cache headers and setup warnings -------------------------------

describe('static frontend edge cases', () => {
    let tempRoot;

    before(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-static-edge-'));
    });

    after(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('a top-level static file is served with no-cache', async () => {
        const staticDir = path.join(tempRoot, 'dist');
        fs.mkdirSync(staticDir);
        fs.writeFileSync(path.join(staticDir, 'index.html'), '<div id="root"></div>');
        fs.writeFileSync(path.join(staticDir, 'robots.txt'), 'User-agent: *');
        const server = await startTestServer({ env: { STATIC_DIR: staticDir } });

        try {
            const response = await fetch(`${server.baseUrl}/robots.txt`);
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('cache-control'), 'no-cache');
        } finally {
            await server.stop();
        }
    });

    test('/licenses serves the third-party notices as plain text', async () => {
        const staticDir = path.join(tempRoot, 'with-notices');
        fs.mkdirSync(staticDir);
        fs.writeFileSync(path.join(staticDir, 'index.html'), '<div id="root"></div>');
        fs.writeFileSync(path.join(staticDir, 'THIRD_PARTY_NOTICES.txt'), 'react 18.3.1\nLicense: MIT');
        const server = await startTestServer({ env: { STATIC_DIR: staticDir } });

        try {
            const response = await fetch(`${server.baseUrl}/licenses`);
            assert.equal(response.status, 200);
            assert.match(response.headers.get('content-type'), /^text\/plain/);
            assert.equal(await response.text(), 'react 18.3.1\nLicense: MIT');
        } finally {
            await server.stop();
        }
    });

    test('/licenses falls through to the app when the build has no notices', async () => {
        const staticDir = path.join(tempRoot, 'without-notices');
        fs.mkdirSync(staticDir);
        fs.writeFileSync(path.join(staticDir, 'index.html'), '<div id="root"></div>');
        const server = await startTestServer({ env: { STATIC_DIR: staticDir } });

        try {
            const response = await fetch(`${server.baseUrl}/licenses`);
            assert.equal(response.status, 200);
            assert.equal(await response.text(), '<div id="root"></div>');
        } finally {
            await server.stop();
        }
    });

    test('a STATIC_DIR without index.html logs a warning and serves nothing', async () => {
        const warnings = [];
        const config = loadConfig({
            AUTH_MODE: 'dev',
            SESSION_SECRET: 'test-secret',
            DATA_DIR: path.join(tempRoot, 'data'),
            STATIC_DIR: path.join(tempRoot, 'empty'),
        });
        const instance = createServer(config, { logger: { ...silentLogger, warn: (message) => warnings.push(message) } });
        await instance.close();

        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /has no index\.html/);
    });
});

// --- Error handler ---------------------------------------------------------

describe('error handler', () => {
    test('a body over the 1 MB limit is 413', async () => {
        const server = await startTestServer();
        try {
            const cookie = await devLogin(server.baseUrl, 'alice@example.com', 'Alice');
            const body = JSON.stringify({ blob: 'x'.repeat(1024 * 1024 + 10) });
            const response = await api(server.baseUrl, 'POST', '/api/rooms', { cookie, body });
            assert.equal(response.status, 413);
            assert.deepEqual(response.body, { message: 'Request body too large' });
        } finally {
            await server.stop();
        }
    });

    test('an unexpected failure is logged and answered with a 500 JSON message', async () => {
        const errors = [];
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-error-'));
        const config = loadConfig({
            AUTH_MODE: 'dev',
            SESSION_SECRET: 'test-secret',
            DATA_DIR: dataDir,
            STATIC_DIR: path.join(dataDir, 'none'),
        });
        const instance = createServer(config, { logger: { ...silentLogger, error: (...args) => errors.push(args) } });
        await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
        const baseUrl = `http://127.0.0.1:${instance.server.address().port}`;

        try {
            const cookie = await devLogin(baseUrl, 'alice@example.com', 'Alice');
            // With the database closed, the next query throws inside a route handler.
            instance.store.close();
            const response = await api(baseUrl, 'GET', '/api/entities/GameRoom', { cookie });
            assert.equal(response.status, 500);
            assert.deepEqual(response.body, { message: 'Internal server error' });
            assert.equal(errors.length, 1);
        } finally {
            instance.hub.close();
            await new Promise((resolve) => instance.server.close(resolve));
            instance.server.closeAllConnections();
            fs.rmSync(dataDir, { recursive: true, force: true });
        }
    });
});
