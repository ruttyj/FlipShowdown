import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { loadConfig } from '../../src/config/config.js';
import { App } from '../../src/providers/App.js';
import { createProviders } from '../../src/providers/index.js';
import { silentLogger } from '../helpers.js';

// The server's providers in a real App over a temp DATA_DIR: what they register, which options
// reach which part, and the boot and shutdown order createServer relies on. The HTTP and realtime
// suites cover the composed server's behaviour end to end.

const PART_NAMES = [
    'config',
    'logger',
    'aiClock',
    'realtimeClock',
    'roomSweepClock',
    'store',
    'database',
    'repositories',
    'authenticator',
    'gameServices',
    'actionRegistry',
    'createRoomAction',
    'lookupByCodeAction',
    'makeHostAction',
    'deleteAction',
    'roomActionRunner',
    'voteTopics',
    'aiRouter',
    'expressApp',
    'httpServer',
    'hub',
    'launcherReporter',
    'roomSweeper',
];

/** Wraps `object[method]` so each call first pushes `label` to `calls`. */
function recordCalls(object, method, label, calls) {
    const original = object[method].bind(object);
    object[method] = (...args) => {
        calls.push(label);
        return original(...args);
    };
}

describe('server providers', () => {
    let dataDir;
    let app;

    beforeEach(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-test-'));
        // A frontend to serve, so the console logger test doesn't print the missing-index warning.
        fs.mkdirSync(path.join(dataDir, 'static'));
        fs.writeFileSync(path.join(dataDir, 'static', 'index.html'), '<!doctype html>');
    });

    afterEach(async () => {
        await app?.close();
        app = null;
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    /** An App with every server provider, started; `options` are createServer's. */
    function startApp(options = {}) {
        const config = loadConfig({
            AUTH_MODE: 'dev',
            SESSION_SECRET: 'test-secret',
            DATA_DIR: dataDir,
            STATIC_DIR: path.join(dataDir, 'static'),
        });
        app = new App(config, { logger: silentLogger, launcherPort: null, ...options });
        for (const provider of createProviders()) {
            app.addProvider(provider);
        }
        app.start();
        return app;
    }

    test('every part the server needs is registered and shares one store and hub', () => {
        startApp();

        for (const name of PART_NAMES) {
            assert.notEqual(app.get(name), undefined, name);
        }
        const store = app.get('store');
        assert.equal(app.get('database'), store.database);
        assert.equal(app.get('repositories'), store.repositories);
        assert.equal(app.get('roomActionRunner').getHub(), app.get('hub'));
        assert.equal(app.get('makeHostAction'), app.get('actionRegistry').require('make-host'));
        assert.equal(app.get('deleteAction'), app.get('actionRegistry').require('delete'));
        assert.equal(app.get('voteTopics')['make-host'].makeHostAction, app.get('makeHostAction'));
    });

    test('the clock options reach their areas, and the logger defaults to console', () => {
        startApp({ logger: undefined, now: () => 1, realtimeNow: () => 2, roomSweepNow: () => 3 });

        assert.equal(app.get('aiClock').now(), 1);
        assert.equal(app.get('realtimeClock').now(), 2);
        assert.equal(app.get('roomSweepClock').now(), 3);
        assert.equal(app.get('logger'), console);
    });

    test('listening sends the launcher stats before the sweep starts', async () => {
        const messages = [];
        startApp({ launcherPort: { postMessage: (message) => messages.push(message) } });
        const calls = [];
        recordCalls(app.get('launcherReporter'), 'sendNow', 'report', calls);
        recordCalls(app.get('roomSweeper'), 'start', 'sweep', calls);

        const server = app.get('httpServer');
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

        assert.deepEqual(calls, ['report', 'sweep']);
        assert.equal(messages.length, 1);
    });

    test('close stops the sweep, reporter and hub, then the HTTP server, then the database', async () => {
        startApp();
        const server = app.get('httpServer');
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const calls = [];
        recordCalls(app.get('roomSweeper'), 'stop', 'sweep', calls);
        recordCalls(app.get('launcherReporter'), 'close', 'reporter', calls);
        recordCalls(app.get('hub'), 'close', 'hub', calls);
        recordCalls(server, 'close', 'server', calls);
        recordCalls(app.get('store'), 'close', 'store', calls);

        await app.close();
        app = null;

        assert.deepEqual(calls, ['sweep', 'reporter', 'hub', 'server', 'store']);
        assert.equal(server.listening, false);
    });
});
