import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { StaticController } from '../../src/http/controllers/StaticController.js';
import { serveApp } from './httpHarness.js';

// StaticController over a temp STATIC_DIR: cache headers, /licenses and the SPA fallback.
// static.test.js covers it in the real server.

describe('StaticController with a built client', () => {
    let staticDir;
    let warnings;
    let harness;

    before(async () => {
        staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-static-'));
        fs.mkdirSync(path.join(staticDir, 'assets'));
        fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>app</title>');
        fs.writeFileSync(path.join(staticDir, 'assets', 'app-abc123.js'), 'console.log(1);');
        fs.writeFileSync(path.join(staticDir, 'THIRD_PARTY_NOTICES.txt'), 'notices');
        warnings = [];
        const controller = new StaticController({ staticDir, logger: { warn: (message) => warnings.push(message) } });
        harness = await serveApp((app) => controller.routes(app));
    });

    after(async () => {
        await harness.close();
        fs.rmSync(staticDir, { recursive: true, force: true });
    });

    test('logs no warning', () => {
        assert.deepEqual(warnings, []);
    });

    test('hashed assets are cached for a year', async () => {
        const response = await harness.request('GET', '/assets/app-abc123.js');

        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    });

    test('a client-side route gets index.html, revalidated', async () => {
        const response = await harness.request('GET', '/room/abc');

        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-cache');
        assert.match(response.text, /<title>app<\/title>/);
    });

    test('/licenses is the notices file as plain text', async () => {
        const response = await harness.request('GET', '/licenses');

        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /^text\/plain; charset=utf-8/);
        assert.equal(response.text, 'notices');
    });

    test('API paths, /login, missing assets and writes are not the SPA', async () => {
        const requests = [
            ['GET', '/api'],
            ['GET', '/api/x'],
            ['GET', '/login'],
            ['GET', '/assets/missing.js'],
            ['POST', '/room/abc'],
        ];
        for (const [method, url] of requests) {
            const response = await harness.request(method, url);
            assert.equal(response.status, 404, `${method} ${url}`);
        }
    });
});

describe('StaticController without a built client', () => {
    test('logs a warning and serves nothing', async () => {
        const staticDir = path.join(os.tmpdir(), 'flip7-static-missing');
        const warnings = [];
        const controller = new StaticController({ staticDir, logger: { warn: (message) => warnings.push(message) } });
        const harness = await serveApp((app) => controller.routes(app));

        try {
            const response = await harness.request('GET', '/');
            assert.equal(response.status, 404);
            assert.deepEqual(warnings, [`STATIC_DIR ${staticDir} has no index.html; not serving the frontend`]);
        } finally {
            await harness.close();
        }
    });

    test('/licenses without the notices file falls through to the SPA index', async () => {
        const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-static-'));
        fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html>');
        const controller = new StaticController({ staticDir, logger: { warn() {} } });
        const harness = await serveApp((app) => controller.routes(app));

        try {
            const response = await harness.request('GET', '/licenses');
            assert.equal(response.status, 200);
            assert.match(response.text, /<!doctype html>/);
        } finally {
            await harness.close();
            fs.rmSync(staticDir, { recursive: true, force: true });
        }
    });
});
