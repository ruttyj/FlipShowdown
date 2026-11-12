import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
    buildServerEnv,
    createLineLog,
    createLineSplitter,
    createServerProcess,
    ROOM_STATS_MESSAGE,
} from '../src/main/serverProcess.js';
import { LAUNCHER_MESSAGE } from '../../shared/launcherMessages.js';

/** Lets piped stream data and exit handlers reach their listeners. */
function flush() {
    return new Promise((resolve) => setImmediate(resolve));
}

// --- Fakes ---

/**
 * Stands in for Electron's UtilityProcess: exit events, piped stdout/stderr and kill().
 * A stubborn child ignores kill(), like a POSIX process that takes its time over SIGTERM.
 */
class FakeChild extends EventEmitter {
    constructor({ stubborn = false } = {}) {
        super();
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
        this.killCount = 0;
        this.stubborn = stubborn;
        // No pid on purpose: the default force kill signals by pid and must never reach a real process.
        this.pid = undefined;
    }

    kill() {
        this.killCount += 1;
        if (!this.stubborn) {
            setImmediate(() => this.emit('exit', 0));
        }
        return true;
    }

    crash(code) {
        this.emit('exit', code);
    }
}

function createFakeFork({ stubborn = false } = {}) {
    const calls = [];
    const fork = (modulePath, args, options) => {
        const child = new FakeChild({ stubborn });
        calls.push({ modulePath, args, options, child });
        return child;
    };
    return { fork, calls };
}

/** A fetch that answers 503 until `healthyAfter` calls have been made, then 200. */
function createFakeFetch({ healthyAfter = 0 } = {}) {
    const urls = [];
    const fetch = async (url) => {
        urls.push(url);
        const isHealthy = urls.length > healthyAfter;
        return { ok: isHealthy, status: isHealthy ? 200 : 503 };
    };
    return { fetch, urls };
}

/** A forceKill stand-in that records its calls and makes the child exit, unless `works` is false. */
function createFakeForceKill({ works = true } = {}) {
    const forced = [];
    const forceKill = (child) => {
        forced.push(child);
        if (works) {
            setImmediate(() => child.emit('exit', null));
        }
    };
    return { forceKill, forced };
}

function createServer(overrides = {}) {
    const { fork, calls } = createFakeFork(overrides.forkOptions);
    const { fetch, urls } = createFakeFetch(overrides.fetchOptions);
    const { forceKill, forced } = createFakeForceKill(overrides.forceKillOptions);
    const server = createServerProcess({
        fork,
        fetch,
        forceKill,
        entryPath: '/app/server/src/index.js',
        serverRoot: '/app/server',
        staticDir: '/app/dist',
        dataDir: '/data',
        port: 7007,
        baseEnv: { PATH: '/bin' },
        healthTimeoutMs: 200,
        healthIntervalMs: 5,
        stopTimeoutMs: 50,
        ...overrides.options,
    });
    const states = [];
    server.on('state', (state) => states.push(state));
    return { server, calls, urls, states, forced };
}

// --- Environment ---

test('the server env carries the launcher config on top of the base env', () => {
    const env = buildServerEnv({
        baseEnv: { PATH: '/bin', AUTH_MODE: 'oidc' },
        port: 7010,
        dataDir: '/data',
        staticDir: '/dist',
    });

    assert.deepEqual(env, {
        PATH: '/bin',
        PORT: '7010',
        DATA_DIR: '/data',
        STATIC_DIR: '/dist',
        AUTH_MODE: 'dev',
        LOCK_GAME_ENTITIES: 'true',
        NODE_ENV: 'production',
    });
});

test('the Gemini key and model are passed only when set', () => {
    const env = buildServerEnv({
        baseEnv: {},
        port: 7007,
        dataDir: '/data',
        staticDir: '/dist',
        geminiApiKey: 'key-123',
        geminiModel: 'gemini-x',
    });

    assert.equal(env.GEMINI_API_KEY, 'key-123');
    assert.equal(env.GEMINI_MODEL, 'gemini-x');
});

test('the session secret is passed only when set, replacing one from the launcher env', () => {
    const input = { baseEnv: { SESSION_SECRET: 'shell-secret' }, port: 7007, dataDir: '/data', staticDir: '/dist' };

    assert.equal(buildServerEnv({ ...input, sessionSecret: 'launcher-secret' }).SESSION_SECRET, 'launcher-secret');
    assert.equal('SESSION_SECRET' in buildServerEnv({ ...input, sessionSecret: '' }), false);
    assert.equal('SESSION_SECRET' in buildServerEnv(input), false);
});

test('server config in the launcher env is dropped so only the launcher settings apply', () => {
    const env = buildServerEnv({
        baseEnv: {
            PATH: '/bin',
            SystemRoot: 'C:\\Windows',
            TEMP: '/tmp',
            GEMINI_API_KEY: 'shell-key',
            GEMINI_MODEL: 'shell-model',
            TRUST_PROXY: 'false',
            SESSION_SECRET: 'shell-secret',
            ENTITIES: 'a,b',
            HOST_OFFLINE_GRACE_SECONDS: '5',
            STALE_ROOM_HOURS: '1',
            CF_ACCESS_AUD: 'aud',
            CF_ACCESS_TEAM_DOMAIN: 'team',
            ADMIN_EMAILS: 'x@y.z',
            NODE_ENV: 'development',
        },
        port: 7007,
        dataDir: '/data',
        staticDir: '/dist',
        geminiApiKey: '',
        geminiModel: '',
    });

    assert.deepEqual(env, {
        PATH: '/bin',
        SystemRoot: 'C:\\Windows',
        TEMP: '/tmp',
        PORT: '7007',
        DATA_DIR: '/data',
        STATIC_DIR: '/dist',
        AUTH_MODE: 'dev',
        LOCK_GAME_ENTITIES: 'true',
        NODE_ENV: 'production',
    });
});

// --- Line log ---

test('the line splitter joins chunks split mid-line and handles CRLF', () => {
    const split = createLineSplitter();

    assert.deepEqual(split('one\r\ntw'), ['one']);
    assert.deepEqual(split('o\nthree'), ['two']);
    assert.deepEqual(split('\n'), ['three']);
});

test('the line splitter caps an endless unterminated line', () => {
    const split = createLineSplitter();

    assert.deepEqual(split('x'.repeat(70 * 1024)), []);
    const [line] = split('\n');

    assert.ok(line.length <= 64 * 1024);
});

test('the line log keeps only the last N lines', () => {
    const log = createLineLog(2);

    log.push('one');
    log.push('two');
    log.push('three');

    assert.deepEqual(log.lines(), ['two', 'three']);
});

// --- Start ---

test('start forks the entry with the env and resolves once /api/health answers', async () => {
    const { server, calls, urls, states } = createServer({ fetchOptions: { healthyAfter: 2 } });

    await server.start();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].modulePath, '/app/server/src/index.js');
    assert.deepEqual(calls[0].args, []);
    assert.equal(calls[0].options.cwd, '/app/server');
    assert.equal(calls[0].options.stdio, 'pipe');
    assert.equal(calls[0].options.env.PORT, '7007');
    assert.equal(urls.length, 3);
    assert.equal(urls[0], 'http://127.0.0.1:7007/api/health');
    assert.deepEqual(states, ['starting', 'running']);
    assert.equal(server.state, 'running');
});

test('start passes the session secret to the server', async () => {
    const { server, calls } = createServer({ options: { sessionSecret: 'secret-abc' } });

    await server.start();

    assert.equal(calls[0].options.env.SESSION_SECRET, 'secret-abc');
});

test('a fetch that throws (server not listening yet) keeps the health wait polling', async () => {
    const { fork } = createFakeFork();
    let calls = 0;
    const fetch = async () => {
        calls += 1;
        if (calls < 3) {
            throw new Error('ECONNREFUSED');
        }
        return { ok: true, status: 200 };
    };
    const server = createServerProcess({
        fork,
        fetch,
        entryPath: '/e.js',
        serverRoot: '/',
        staticDir: '/dist',
        dataDir: '/data',
        port: 1,
        healthIntervalMs: 1,
    });

    await server.start();

    assert.equal(server.state, 'running');
});

test('a health wait timeout puts the server in error and kills the child', async () => {
    const { server, calls, states } = createServer({ fetchOptions: { healthyAfter: Infinity } });

    await assert.rejects(server.start(), /did not answer \/api\/health/);

    assert.equal(server.state, 'error');
    assert.deepEqual(states, ['starting', 'error']);
    assert.equal(calls[0].child.killCount, 1);
});

test('a child that exits during startup fails start with its exit code', async () => {
    const { server, calls } = createServer({ fetchOptions: { healthyAfter: Infinity } });

    const starting = server.start();
    calls[0].child.crash(1);

    await assert.rejects(starting, /exited with code 1/);
    assert.equal(server.state, 'error');
});

test('a fork that throws synchronously rejects start and puts the server in error', async () => {
    const server = createServerProcess({
        fork: () => {
            throw new Error('spawn UNKNOWN');
        },
        fetch: async () => ({ ok: true, status: 200 }),
        entryPath: '/e.js',
        serverRoot: '/',
        staticDir: '/dist',
        dataDir: '/data',
        port: 1,
    });

    await assert.rejects(server.start(), /spawn UNKNOWN/);
    assert.equal(server.state, 'error');
});

test('a failed start whose child ignores kill() is force-killed, and stop() waits for it', async () => {
    const { server, calls, forced } = createServer({
        fetchOptions: { healthyAfter: Infinity },
        forkOptions: { stubborn: true },
    });

    await assert.rejects(server.start(), /did not answer \/api\/health/);
    await server.stop();

    assert.equal(calls[0].child.killCount, 1);
    assert.deepEqual(forced, [calls[0].child]);
    assert.equal(server.state, 'error');
});

test('a health answer from an old start does not mark a newer start running', async () => {
    const { fork, calls } = createFakeFork();
    /** @type {Array<(response: { ok: boolean, status: number }) => void>} */
    const answers = [];
    const fetch = () => new Promise((resolve) => {
        answers.push(resolve);
    });
    const server = createServerProcess({
        fork,
        fetch,
        entryPath: '/e.js',
        serverRoot: '/',
        staticDir: '/dist',
        dataDir: '/data',
        port: 1,
        stopTimeoutMs: 50,
    });

    const first = assert.rejects(server.start(), /stopped while starting/);
    await server.stop();
    const second = server.start();
    answers[0]({ ok: true, status: 200 });
    await first;

    assert.equal(server.state, 'starting');
    answers[1]({ ok: true, status: 200 });
    await second;
    assert.equal(server.state, 'running');
    assert.equal(calls.length, 2);
    await server.stop();
});

test('start twice is refused while a server is running', async () => {
    const { server } = createServer();

    await server.start();

    await assert.rejects(server.start(), /already/);
});

// --- Crash after start ---

test('a crash after start moves to error and emits exit as unexpected', async () => {
    const { server, calls, states } = createServer();
    const exits = [];
    server.on('exit', (exit) => exits.push(exit));
    await server.start();

    calls[0].child.stderr.write('boom: database locked\n');
    await flush();
    calls[0].child.crash(3);
    await flush();

    assert.equal(server.state, 'error');
    assert.deepEqual(states, ['starting', 'running', 'error']);
    assert.deepEqual(exits, [{ code: 3, expected: false }]);
    assert.deepEqual(server.logLines, ['boom: database locked']);
});

test('a utility-process error event is logged and moves a running server to error', async () => {
    const { server, calls } = createServer();
    const exits = [];
    server.on('exit', (exit) => exits.push(exit));
    await server.start();

    calls[0].child.emit('error', 'FatalError', 'v8::Heap', '/tmp/report.json');
    await flush();

    assert.equal(server.state, 'error');
    assert.deepEqual(exits, [{ code: null, expected: false }]);
    assert.ok(server.logLines.some((line) => line.includes('FatalError')));
});

// --- Logs ---

test('stdout and stderr lines are kept and emitted as log events', async () => {
    const { server, calls } = createServer({ options: { maxLogLines: 2 } });
    const logged = [];
    server.on('log', (line) => logged.push(line));
    await server.start();

    calls[0].child.stdout.write('listening on 7007\n');
    calls[0].child.stderr.write('warn one\nwarn two\n');
    await flush();

    assert.deepEqual(logged, ['listening on 7007', 'warn one', 'warn two']);
    assert.deepEqual(server.logLines, ['warn one', 'warn two']);
});

test('a last output line without a newline is still logged when the stream ends', async () => {
    const { server, calls } = createServer();
    await server.start();

    calls[0].child.stderr.end('fatal: no newline');
    await flush();

    assert.deepEqual(server.logLines, ['fatal: no newline']);
});

// --- Stop ---

test('stop kills the child, ends stopped and reports an expected exit', async () => {
    const { server, calls, states } = createServer();
    const exits = [];
    server.on('exit', (exit) => exits.push(exit));
    await server.start();

    await server.stop();

    assert.equal(calls[0].child.killCount, 1);
    assert.equal(server.state, 'stopped');
    assert.deepEqual(states, ['starting', 'running', 'stopping', 'stopped']);
    assert.deepEqual(exits, [{ code: 0, expected: true }]);
});

test('stop during startup rejects the pending start without an error state', async () => {
    const { server } = createServer({ fetchOptions: { healthyAfter: Infinity } });

    const starting = assert.rejects(server.start(), /stopped while starting/);
    await server.stop();

    await starting;
    assert.equal(server.state, 'stopped');
});

test('a health answer that lands after stop() does not mark the server running', async () => {
    const { fork } = createFakeFork();
    /** @type {(response: { ok: boolean, status: number }) => void} */
    let answerHealth = () => {};
    const fetch = () => new Promise((resolve) => {
        answerHealth = resolve;
    });
    const server = createServerProcess({
        fork,
        fetch,
        entryPath: '/e.js',
        serverRoot: '/',
        staticDir: '/dist',
        dataDir: '/data',
        port: 1,
    });

    const starting = assert.rejects(server.start(), /stopped while starting/);
    const stopping = server.stop();
    answerHealth({ ok: true, status: 200 });

    await starting;
    await stopping;
    assert.equal(server.state, 'stopped');
});

test('stop is idempotent and safe before start', async () => {
    const { server, calls } = createServer();

    await server.stop();
    await server.start();
    await Promise.all([server.stop(), server.stop()]);
    await server.stop();

    assert.equal(calls[0].child.killCount, 1);
    assert.equal(server.state, 'stopped');
});

test('stop force-kills a child that ignores kill() and then ends stopped', async () => {
    const { server, calls, forced } = createServer({ forkOptions: { stubborn: true } });
    const exits = [];
    server.on('exit', (exit) => exits.push(exit));
    await server.start();

    await server.stop();

    assert.equal(calls[0].child.killCount, 1);
    assert.deepEqual(forced, [calls[0].child]);
    assert.equal(server.state, 'stopped');
    assert.deepEqual(exits, [{ code: null, expected: true }]);
});

test('stop ends in error when even the force kill does not end the child', async () => {
    const { server, forced } = createServer({
        forkOptions: { stubborn: true },
        forceKillOptions: { works: false },
    });
    await server.start();

    await server.stop();

    assert.equal(forced.length, 1);
    assert.equal(server.state, 'error');
});

test('the default force kill tolerates a child without a pid', async () => {
    const { server } = createServer({
        forkOptions: { stubborn: true },
        options: { forceKill: undefined },
    });
    await server.start();

    await server.stop();

    assert.equal(server.state, 'error');
    assert.ok(server.logLines.some((line) => line.includes('even after a force kill')));
});

test('a server can be started again after a stop', async () => {
    const { server, calls } = createServer();
    await server.start();
    await server.stop();

    await server.start();

    assert.equal(calls.length, 2);
    assert.equal(server.state, 'running');
});

// --- Room stats ---

test('the room stats message type matches the one the server sends', () => {
    assert.equal(ROOM_STATS_MESSAGE, LAUNCHER_MESSAGE.ROOM_STATS);
});

test('room stats from the server are passed on, and other messages are ignored', async () => {
    const { server, calls } = createServer();
    const received = [];
    server.on('room-stats', (stats) => received.push(stats));
    await server.start();
    const stats = { playersOnline: 2, roomsLive: 1, rooms: [] };

    calls[0].child.emit('message', { type: 'room-stats', stats });
    calls[0].child.emit('message', { type: 'something-else' });
    calls[0].child.emit('message', null);

    assert.deepEqual(received, [stats]);
});

test('room stats from a server that has been replaced are ignored', async () => {
    const { server, calls } = createServer();
    const received = [];
    server.on('room-stats', (stats) => received.push(stats));
    await server.start();
    await server.stop();
    await server.start();

    calls[0].child.emit('message', { type: 'room-stats', stats: { playersOnline: 9 } });

    assert.deepEqual(received, []);
});
