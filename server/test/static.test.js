import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startTestServer } from './helpers.js';

describe('static frontend', () => {
    let server;
    let staticDir;

    before(async () => {
        staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-static-'));
        fs.mkdirSync(path.join(staticDir, 'assets'));
        fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><div id="root"></div>');
        fs.writeFileSync(path.join(staticDir, 'assets', 'index-abc123.js'), 'console.log(1)');
        server = await startTestServer({ env: { STATIC_DIR: staticDir } });
    });

    after(async () => {
        await server.stop();
        fs.rmSync(staticDir, { recursive: true, force: true });
    });

    test('hashed assets get a long immutable cache', async () => {
        const response = await fetch(`${server.baseUrl}/assets/index-abc123.js`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('cache-control'), /max-age=31536000, immutable/);
    });

    test('client routes fall back to index.html with no-cache', async () => {
        for (const urlPath of ['/', '/GameRoom?id=1', '/some/deep/route']) {
            const response = await fetch(`${server.baseUrl}${urlPath}`);
            assert.equal(response.status, 200, urlPath);
            assert.equal(response.headers.get('cache-control'), 'no-cache');
            assert.match(await response.text(), /id="root"/);
        }
    });

    test('missing assets and API paths do not fall back', async () => {
        const asset = await fetch(`${server.baseUrl}/assets/missing.js`);
        assert.equal(asset.status, 404);

        const apiPath = await fetch(`${server.baseUrl}/api/health`);
        assert.deepEqual(await apiPath.json(), { ok: true });

        const login = await fetch(`${server.baseUrl}/login`);
        assert.match(await login.text(), /<form/);
    });
});
