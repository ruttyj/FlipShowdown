import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createHostingSession, installQuitCleanup } from '../src/main/hostingSession.js';

const URL_A = 'https://calm-river-1234.trycloudflare.com';
const URL_B = 'https://bold-lake-5678.trycloudflare.com';

// --- Fakes ---------------------------------------------------------------------------------

/**
 * Stands in for serverProcess/tunnelProcess. start() stays pending until the test calls
 * succeed() or fail(); stop() rejects a pending start, as the real modules do.
 */
class FakeProcess extends EventEmitter {
    constructor(name, order) {
        super();
        this.name = name;
        this.order = order;
        this.logLines = [];
        this.startCount = 0;
        this.stopCount = 0;
        this.pending = null;
        this.stopError = null;
        /** @type {number | null} the port the session created it with */
        this.port = null;
    }

    start() {
        this.startCount += 1;
        this.order.push(`${this.name}.start`);
        return new Promise((resolve, reject) => {
            this.pending = { resolve, reject };
        });
    }

    stop() {
        this.stopCount += 1;
        this.order.push(`${this.name}.stop`);
        if (this.pending) {
            this.pending.reject(new Error(`${this.name} stopped while starting`));
            this.pending = null;
        }
        if (this.stopError) {
            return Promise.reject(this.stopError);
        }
        return Promise.resolve();
    }

    succeed(value) {
        this.pending.resolve(value);
        this.pending = null;
    }

    fail(message) {
        this.pending.reject(new Error(message));
        this.pending = null;
    }

    writeLog(line) {
        this.logLines.push(line);
        this.emit('log', line);
    }

    exitUnexpectedly(code) {
        this.emit('exit', { code, expected: false });
    }
}

/** Timers the test fires by hand, so backoff delays take no real time. */
function createFakeTimers() {
    const pending = new Map();
    let nextHandle = 1;

    return {
        setTimeout(callback, ms) {
            const handle = nextHandle;
            nextHandle += 1;
            pending.set(handle, { callback, ms });
            return handle;
        },
        clearTimeout(handle) {
            pending.delete(handle);
        },
        delays() {
            return [...pending.values()].map((timer) => timer.ms);
        },
        fireAll() {
            const due = [...pending.entries()];
            pending.clear();
            for (const [, timer] of due) {
                timer.callback();
            }
        },
    };
}

function flush() {
    return new Promise((resolve) => setImmediate(resolve));
}

function createHarness(overrides = {}) {
    const order = [];
    const servers = [];
    const tunnels = [];
    const timers = createFakeTimers();
    const clock = { now: 0 };
    const keepAwake = {
        active: false,
        start() {
            this.active = true;
            order.push('keepAwake.start');
        },
        stop() {
            this.active = false;
            order.push('keepAwake.stop');
        },
    };

    const session = createHostingSession({
        pickPort: async () => 7007,
        createServer: ({ port }) => {
            const server = new FakeProcess('server', order);
            server.port = port;
            servers.push(server);
            return server;
        },
        createTunnel: ({ port }) => {
            const tunnel = new FakeProcess('tunnel', order);
            tunnel.port = port;
            tunnels.push(tunnel);
            return tunnel;
        },
        keepAwake,
        timers,
        now: () => clock.now,
        ...overrides,
    });

    const statuses = [];
    const snapshots = [];
    session.on('state', (snapshot) => {
        snapshots.push(snapshot);
        if (statuses.at(-1) !== snapshot.status) {
            statuses.push(snapshot.status);
        }
    });

    return { session, order, servers, tunnels, timers, clock, keepAwake, statuses, snapshots };
}

/** Starts hosting and drives the fakes until the session is hosting on `url`. */
async function startHosting(harness, url = URL_A) {
    const started = harness.session.start();
    await flush();
    harness.servers.at(-1).succeed();
    await flush();
    harness.tunnels.at(-1).succeed(url);
    return started;
}

/** The tunnel dies while hosting; then the backoff timer fires and the restart begins. */
async function dropTunnel(harness) {
    harness.tunnels.at(-1).exitUnexpectedly(1);
    await flush();
    harness.timers.fireAll();
    await flush();
}

// --- Starting ------------------------------------------------------------------------------

test('start picks a port, starts the server, then the tunnel, and ends up hosting', async () => {
    const harness = createHarness();

    const snapshot = await startHosting(harness);

    assert.deepEqual(harness.statuses, ['starting-server', 'starting-tunnel', 'hosting']);
    assert.deepEqual(harness.order, ['server.start', 'tunnel.start', 'keepAwake.start']);
    assert.equal(harness.servers[0].port, 7007);
    assert.equal(harness.tunnels[0].port, 7007);
    assert.equal(snapshot.status, 'hosting');
    assert.equal(snapshot.port, 7007);
    assert.equal(snapshot.url, URL_A);
    assert.equal(snapshot.previousUrl, null);
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.retry, null);
});

test('the server gets the port pickPort chose', async () => {
    const harness = createHarness({ pickPort: async () => 51234 });

    const snapshot = await startHosting(harness);

    assert.equal(harness.servers[0].port, 51234);
    assert.equal(harness.tunnels[0].port, 51234);
    assert.equal(snapshot.port, 51234);
});

test('getState starts idle with nothing running', () => {
    const { session } = createHarness();

    assert.deepEqual(session.getState(), {
        status: 'idle',
        port: null,
        url: null,
        previousUrl: null,
        error: null,
        retry: null,
        serverLog: [],
        tunnelLog: [],
    });
});

test('server and tunnel output is re-emitted and kept in the snapshot', async () => {
    const harness = createHarness();
    const lines = [];
    harness.session.on('log', (entry) => lines.push(entry));

    await startHosting(harness);
    harness.servers[0].writeLog('listening on 7007');
    harness.tunnels[0].writeLog('INF Registered tunnel connection');

    assert.deepEqual(lines, [
        { source: 'server', line: 'listening on 7007' },
        { source: 'tunnel', line: 'INF Registered tunnel connection' },
    ]);
    const snapshot = harness.session.getState();
    assert.deepEqual(snapshot.serverLog, ['listening on 7007']);
    assert.deepEqual(snapshot.tunnelLog, ['INF Registered tunnel connection']);
});

test('concurrent start calls share one start', async () => {
    const harness = createHarness();

    const first = harness.session.start();
    const second = harness.session.start();
    await flush();
    harness.servers[0].succeed();
    await flush();
    harness.tunnels[0].succeed(URL_A);

    assert.equal(first, second);
    await first;
    assert.equal(harness.servers.length, 1);
});

test('start while hosting resolves straight away without starting anything new', async () => {
    const harness = createHarness();
    await startHosting(harness);

    const snapshot = await harness.session.start();

    assert.equal(snapshot.status, 'hosting');
    assert.equal(harness.servers.length, 1);
    assert.equal(harness.tunnels.length, 1);
});

test('the default policy, clock and timers are used when none are given', async () => {
    const order = [];
    const session = createHostingSession({
        pickPort: async () => 7007,
        createServer: () => new FakeProcess('server', order),
        createTunnel: () => new FakeProcess('tunnel', order),
        keepAwake: { start() {}, stop() {} },
    });

    const started = session.start();
    await session.stop();

    assert.equal((await started).status, 'idle');
});

test('the global timers run a real backoff', async () => {
    const tunnels = [];
    const session = createHostingSession({
        pickPort: async () => 7007,
        createServer: () => {
            const server = new FakeProcess('server', []);
            queueMicrotask(() => server.succeed());
            return server;
        },
        createTunnel: () => {
            const tunnel = new FakeProcess('tunnel', []);
            tunnels.push(tunnel);
            return tunnel;
        },
        keepAwake: { start() {}, stop() {} },
        retryPolicy: { maxRetries: 1, baseDelayMs: 1, backoffFactor: 1, maxDelayMs: 1, stableAfterMs: 1 },
    });

    const started = session.start();
    await flush();
    await flush();
    tunnels[0].fail('first try');
    await new Promise((resolve) => setTimeout(resolve, 20));
    tunnels[0].succeed(URL_A);

    assert.equal((await started).status, 'hosting');
    assert.equal(tunnels[0].startCount, 2);
    await session.stop();
});

// --- Keep-awake ----------------------------------------------------------------------------

test('keep-awake runs only while hosting and stops when hosting stops', async () => {
    const harness = createHarness();

    harness.session.start();
    await flush();
    assert.equal(harness.keepAwake.active, false);
    harness.servers[0].succeed();
    await flush();
    assert.equal(harness.keepAwake.active, false);
    harness.tunnels[0].succeed(URL_A);
    await flush();
    assert.equal(harness.keepAwake.active, true);

    await harness.session.stop();

    assert.equal(harness.keepAwake.active, false);
});

test('keep-awake stays on through a tunnel restart', async () => {
    const harness = createHarness();
    await startHosting(harness);

    await dropTunnel(harness);
    harness.tunnels[0].succeed(URL_B);
    await flush();

    const keepAwakeCalls = harness.order.filter((entry) => entry.startsWith('keepAwake'));
    assert.deepEqual(keepAwakeCalls, ['keepAwake.start']);
    assert.equal(harness.keepAwake.active, true);
});

// --- Tunnel restarts (decision 14) ----------------------------------------------------------

test('a tunnel exit while hosting restarts the tunnel after a backoff', async () => {
    const harness = createHarness();
    await startHosting(harness);

    harness.tunnels[0].exitUnexpectedly(1);
    await flush();

    const restarting = harness.session.getState();
    assert.equal(restarting.status, 'tunnel-restarting');
    assert.equal(restarting.url, null);
    assert.deepEqual(restarting.retry, { attempt: 1, maxRetries: 3, delayMs: 1000 });
    assert.deepEqual(harness.timers.delays(), [1000]);
    assert.equal(harness.tunnels[0].startCount, 1);

    harness.timers.fireAll();
    await flush();
    assert.equal(harness.tunnels[0].startCount, 2);
    assert.equal(harness.servers[0].stopCount, 0);
});

test('a restarted tunnel on a new URL emits url-changed and records the previous URL', async () => {
    const harness = createHarness();
    const changes = [];
    harness.session.on('url-changed', (change) => changes.push(change));
    await startHosting(harness);

    await dropTunnel(harness);
    harness.tunnels[0].succeed(URL_B);
    await flush();

    assert.deepEqual(changes, [{ previousUrl: URL_A, url: URL_B }]);
    const snapshot = harness.session.getState();
    assert.equal(snapshot.status, 'hosting');
    assert.equal(snapshot.url, URL_B);
    assert.equal(snapshot.previousUrl, URL_A);
    assert.equal(snapshot.retry, null);
});

test('every URL change emits again, naming the URL it replaced', async () => {
    const harness = createHarness();
    const changes = [];
    harness.session.on('url-changed', (change) => changes.push(change));
    await startHosting(harness);
    const URL_C = 'https://late-moon-9999.trycloudflare.com';

    await dropTunnel(harness);
    harness.tunnels[0].succeed(URL_B);
    await flush();
    await dropTunnel(harness);
    harness.tunnels[0].succeed(URL_C);
    await flush();

    assert.deepEqual(changes, [
        { previousUrl: URL_A, url: URL_B },
        { previousUrl: URL_B, url: URL_C },
    ]);
});

test('a restart that comes back on the same URL does not emit url-changed', async () => {
    const harness = createHarness();
    const changes = [];
    harness.session.on('url-changed', (change) => changes.push(change));
    await startHosting(harness);

    await dropTunnel(harness);
    harness.tunnels[0].succeed(URL_A);
    await flush();

    assert.deepEqual(changes, []);
    assert.equal(harness.session.getState().previousUrl, null);
});

test('failed restarts back off 1 s, 2 s, 4 s, then the session fails', async () => {
    const harness = createHarness();
    await startHosting(harness);

    harness.tunnels[0].exitUnexpectedly(1);
    await flush();
    const delays = [...harness.timers.delays()];
    for (let attempt = 0; attempt < 3; attempt += 1) {
        harness.timers.fireAll();
        await flush();
        harness.tunnels[0].fail('cloudflared exited with code 1 before it was ready');
        await flush();
        delays.push(...harness.timers.delays());
    }
    await flush();

    assert.deepEqual(delays, [1000, 2000, 4000]);
    const snapshot = harness.session.getState();
    assert.equal(snapshot.status, 'failed');
    assert.match(snapshot.error, /tunnel failed 4 times in a row/);
    assert.match(snapshot.error, /before it was ready/);
    assert.equal(snapshot.retry, null);
    assert.equal(snapshot.url, null);
    assert.equal(harness.keepAwake.active, false);
    assert.deepEqual(harness.order.slice(-2), ['tunnel.stop', 'server.stop']);
});

test('a first tunnel start that fails is retried while still starting', async () => {
    const harness = createHarness();

    const started = harness.session.start();
    await flush();
    harness.servers[0].succeed();
    await flush();
    harness.tunnels[0].fail('rate limited');
    await flush();

    const waiting = harness.session.getState();
    assert.equal(waiting.status, 'starting-tunnel');
    assert.deepEqual(waiting.retry, { attempt: 1, maxRetries: 3, delayMs: 1000 });

    harness.timers.fireAll();
    await flush();
    harness.tunnels[0].succeed(URL_A);

    const snapshot = await started;
    assert.equal(snapshot.status, 'hosting');
    assert.equal(snapshot.retry, null);
    assert.equal(snapshot.previousUrl, null);
});

test('a tunnel exit while the first tunnel starts is not treated as a drop', async () => {
    const harness = createHarness();

    const started = harness.session.start();
    await flush();
    harness.servers[0].succeed();
    await flush();
    harness.tunnels[0].exitUnexpectedly(1);
    await flush();

    assert.equal(harness.session.getState().status, 'starting-tunnel');
    assert.deepEqual(harness.timers.delays(), []);
    harness.tunnels[0].succeed(URL_A);
    assert.equal((await started).status, 'hosting');
});

test('a first tunnel that never comes up fails the start', async () => {
    const harness = createHarness({
        retryPolicy: { maxRetries: 0, baseDelayMs: 1, backoffFactor: 1, maxDelayMs: 1, stableAfterMs: 1 },
    });

    const started = harness.session.start();
    await flush();
    harness.servers[0].succeed();
    await flush();
    harness.tunnels[0].fail('ENOENT');

    const snapshot = await started;
    assert.equal(snapshot.status, 'failed');
    assert.match(snapshot.error, /ENOENT/);
    assert.deepEqual(harness.statuses, ['starting-server', 'starting-tunnel', 'stopping', 'failed']);
});

test('a tunnel that stayed up long enough starts its retry count afresh', async () => {
    const harness = createHarness();
    await startHosting(harness);

    await dropTunnel(harness);
    harness.tunnels[0].succeed(URL_B);
    await flush();
    harness.clock.now += 60_000;
    harness.tunnels[0].exitUnexpectedly(1);
    await flush();

    assert.deepEqual(harness.session.getState().retry, { attempt: 1, maxRetries: 3, delayMs: 1000 });
});

test('an expected tunnel exit is not treated as a drop', async () => {
    const harness = createHarness();
    await startHosting(harness);

    harness.tunnels[0].emit('exit', { code: 0, expected: true });
    await flush();

    assert.equal(harness.session.getState().status, 'hosting');
    assert.deepEqual(harness.timers.delays(), []);
});

// --- Retry after failure -------------------------------------------------------------------

test('retry from failed starts everything again with a fresh retry count', async () => {
    const harness = createHarness();
    await startHosting(harness);
    harness.servers[0].exitUnexpectedly(1);
    await flush();
    assert.equal(harness.session.getState().status, 'failed');

    const retried = harness.session.retry();
    await flush();
    harness.servers[1].succeed();
    await flush();
    harness.tunnels[1].succeed(URL_B);

    const snapshot = await retried;
    assert.equal(snapshot.status, 'hosting');
    assert.equal(snapshot.url, URL_B);
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.previousUrl, null);
    assert.equal(harness.servers.length, 2);
});

test('retry outside the failed state does nothing', async () => {
    const harness = createHarness();

    const idle = await harness.session.retry();
    assert.equal(idle.status, 'idle');
    assert.equal(harness.servers.length, 0);

    const started = harness.session.start();
    assert.equal(harness.session.retry(), started);
    await flush();
    harness.servers[0].succeed();
    await flush();
    harness.tunnels[0].succeed(URL_A);
    await started;

    const hosting = await harness.session.retry();
    assert.equal(hosting.status, 'hosting');
    assert.equal(harness.servers.length, 1);
});

test('events from a failed run do not touch the next run', async () => {
    const harness = createHarness();
    await startHosting(harness);
    harness.servers[0].exitUnexpectedly(1);
    await flush();
    await startHosting(harness, URL_B);

    harness.servers[0].exitUnexpectedly(1);
    harness.tunnels[0].exitUnexpectedly(1);
    await flush();

    assert.equal(harness.session.getState().status, 'hosting');
    assert.equal(harness.session.getState().url, URL_B);
});

// --- Crashes -------------------------------------------------------------------------------

test('a server crash while hosting stops the tunnel and fails', async () => {
    const harness = createHarness();
    await startHosting(harness);

    harness.servers[0].exitUnexpectedly(3);
    await flush();

    const snapshot = harness.session.getState();
    assert.equal(snapshot.status, 'failed');
    assert.match(snapshot.error, /exit code 3/);
    assert.equal(harness.keepAwake.active, false);
    assert.equal(harness.tunnels[0].stopCount, 1);
    assert.deepEqual(harness.statuses, ['starting-server', 'starting-tunnel', 'hosting', 'stopping', 'failed']);
});

test('a server crash while the tunnel restarts cancels the pending restart', async () => {
    const harness = createHarness();
    await startHosting(harness);
    harness.tunnels[0].exitUnexpectedly(1);
    await flush();

    harness.servers[0].exitUnexpectedly(1);
    await flush();
    harness.timers.fireAll();
    await flush();

    assert.equal(harness.session.getState().status, 'failed');
    assert.deepEqual(harness.timers.delays(), []);
    assert.equal(harness.tunnels[0].startCount, 1);
});

test('a server crash while the first tunnel starts fails the start', async () => {
    const harness = createHarness();

    const started = harness.session.start();
    await flush();
    harness.servers[0].succeed();
    await flush();
    harness.servers[0].exitUnexpectedly(1);

    const snapshot = await started;
    assert.equal(snapshot.status, 'failed');
    assert.match(snapshot.error, /game server stopped unexpectedly/);
    assert.equal(harness.tunnels[0].stopCount, 1);
});

test('a server that fails to start fails the session without a tunnel', async () => {
    const harness = createHarness();

    const started = harness.session.start();
    await flush();
    harness.servers[0].fail('The server did not answer /api/health within 15000 ms');

    const snapshot = await started;
    assert.equal(snapshot.status, 'failed');
    assert.match(snapshot.error, /api\/health/);
    assert.equal(harness.tunnels.length, 0);
    assert.equal(harness.keepAwake.active, false);
});

test('a port that cannot be picked fails the session', async () => {
    const harness = createHarness({
        pickPort: async () => {
            throw new Error('no free port');
        },
    });

    const snapshot = await harness.session.start();

    assert.equal(snapshot.status, 'failed');
    assert.equal(snapshot.error, 'no free port');
    assert.equal(harness.servers.length, 0);
});

test('a non-Error failure is still reported as text', async () => {
    const harness = createHarness({
        pickPort: async () => {
            throw 'port probe broke';
        },
    });

    const snapshot = await harness.session.start();

    assert.equal(snapshot.error, 'port probe broke');
});

test('an expected server exit is not treated as a crash', async () => {
    const harness = createHarness();
    await startHosting(harness);

    harness.servers[0].emit('exit', { code: 0, expected: true });
    await flush();

    assert.equal(harness.session.getState().status, 'hosting');
});

// --- Stopping ------------------------------------------------------------------------------

test('stop kills the tunnel first, then the server, and returns to idle', async () => {
    const harness = createHarness();
    await startHosting(harness);
    harness.order.length = 0;

    await harness.session.stop();

    assert.deepEqual(harness.order, ['keepAwake.stop', 'tunnel.stop', 'server.stop']);
    assert.deepEqual(harness.statuses.slice(-2), ['stopping', 'idle']);
    const snapshot = harness.session.getState();
    assert.equal(snapshot.status, 'idle');
    assert.equal(snapshot.url, null);
    assert.equal(snapshot.port, null);
});

test('stop is idempotent: concurrent calls share one stop, and later calls do nothing', async () => {
    const harness = createHarness();
    await startHosting(harness);

    const first = harness.session.stop();
    const second = harness.session.stop();
    assert.equal(first, second);
    await first;
    await harness.session.stop();

    assert.equal(harness.tunnels[0].stopCount, 1);
    assert.equal(harness.servers[0].stopCount, 1);
});

test('stop while idle does nothing', async () => {
    const harness = createHarness();

    await harness.session.stop();

    assert.deepEqual(harness.order, []);
    assert.deepEqual(harness.statuses, []);
});

test('stop while picking a port aborts before the server starts', async () => {
    /** @type {{ release: (port: number) => void }} */
    const portRequest = { release: () => {} };
    const harness = createHarness({
        pickPort: () => new Promise((resolve) => {
            portRequest.release = resolve;
        }),
    });

    const started = harness.session.start();
    const stopped = harness.session.stop();
    portRequest.release(7007);
    await stopped;

    assert.equal((await started).status, 'idle');
    assert.equal(harness.servers.length, 0);
});

test('stop while the server starts aborts the start and stops the server', async () => {
    const harness = createHarness();

    const started = harness.session.start();
    await flush();
    await harness.session.stop();

    assert.equal((await started).status, 'idle');
    assert.equal(harness.servers[0].stopCount, 1);
    assert.equal(harness.tunnels.length, 0);
});

test('stop while the tunnel starts stops the tunnel, then the server', async () => {
    const harness = createHarness();

    const started = harness.session.start();
    await flush();
    harness.servers[0].succeed();
    await flush();
    harness.order.length = 0;
    await harness.session.stop();

    assert.equal((await started).status, 'idle');
    assert.deepEqual(harness.order, ['tunnel.stop', 'server.stop']);
    assert.deepEqual(harness.timers.delays(), []);
});

test('a server start that finishes just as stop runs does not start the tunnel', async () => {
    const harness = createHarness();

    const started = harness.session.start();
    await flush();
    harness.servers[0].succeed();
    const stopped = harness.session.stop();
    await stopped;

    assert.equal((await started).status, 'idle');
    assert.equal(harness.tunnels.length, 0);
});

test('a tunnel that becomes ready just as stop runs is not reported as hosting', async () => {
    const harness = createHarness();

    const started = harness.session.start();
    await flush();
    harness.servers[0].succeed();
    await flush();
    harness.tunnels[0].succeed(URL_A);
    const stopped = harness.session.stop();
    await stopped;

    assert.equal((await started).status, 'idle');
    assert.equal(harness.keepAwake.active, false);
    assert.equal(harness.statuses.includes('hosting'), false);
});

test('stop during a restart backoff cancels the timer and stops everything', async () => {
    const harness = createHarness();
    await startHosting(harness);
    harness.tunnels[0].exitUnexpectedly(1);
    await flush();

    await harness.session.stop();

    assert.deepEqual(harness.timers.delays(), []);
    assert.equal(harness.session.getState().status, 'idle');
    assert.equal(harness.tunnels[0].startCount, 1);
    assert.equal(harness.keepAwake.active, false);
});

test('stop while a restarted tunnel starts stops it and does not report hosting', async () => {
    const harness = createHarness();
    await startHosting(harness);
    await dropTunnel(harness);
    assert.equal(harness.tunnels[0].startCount, 2);

    await harness.session.stop();
    await flush();

    assert.equal(harness.session.getState().status, 'idle');
    assert.equal(harness.tunnels[0].stopCount, 1);
    assert.equal(harness.servers[0].stopCount, 1);
    assert.equal(harness.keepAwake.active, false);
    assert.deepEqual(harness.timers.delays(), []);
});

test('stop from failed clears the error and returns to idle', async () => {
    const harness = createHarness();
    await startHosting(harness);
    harness.servers[0].exitUnexpectedly(1);
    await flush();

    await harness.session.stop();

    const snapshot = harness.session.getState();
    assert.equal(snapshot.status, 'idle');
    assert.equal(snapshot.error, null);
});

test('stop during a failure teardown ends in idle instead of failed', async () => {
    const harness = createHarness();
    await startHosting(harness);

    harness.servers[0].exitUnexpectedly(1);
    assert.equal(harness.session.getState().status, 'stopping');
    await harness.session.stop();

    assert.equal(harness.session.getState().status, 'idle');
    assert.equal(harness.session.getState().error, null);
});

test('start while stopping waits for the stop, then starts again', async () => {
    const harness = createHarness();
    await startHosting(harness);

    const stopped = harness.session.stop();
    const restarted = harness.session.start();
    await stopped;
    await flush();
    harness.servers[1].succeed();
    await flush();
    harness.tunnels[1].succeed(URL_B);

    assert.equal((await restarted).status, 'hosting');
    assert.equal(harness.servers[0].stopCount, 1);
});

test('a start queued behind a stop is dropped when stop is called again', async () => {
    const harness = createHarness();
    await startHosting(harness);

    harness.session.stop();
    const restarted = harness.session.start();
    harness.session.stop();

    assert.equal((await restarted).status, 'idle');
    assert.equal(harness.servers.length, 1);
});

test('the server is stopped even when stopping the tunnel fails', async () => {
    const harness = createHarness();
    await startHosting(harness);
    harness.tunnels[0].stopError = new Error('kill failed');

    await assert.rejects(harness.session.stop(), /kill failed/);

    assert.equal(harness.servers[0].stopCount, 1);
    assert.equal(harness.session.getState().status, 'idle');
});

test('a state listener that throws on stopping still stops the tunnel, then the server', async () => {
    const harness = createHarness();
    await startHosting(harness);
    harness.session.on('state', (snapshot) => {
        if (snapshot.status === 'stopping') {
            throw new Error('Object has been destroyed');
        }
    });
    harness.order.length = 0;

    let stopped;
    assert.doesNotThrow(() => {
        stopped = harness.session.stop();
    });
    await assert.rejects(stopped, /Object has been destroyed/);

    assert.deepEqual(harness.order, ['keepAwake.stop', 'tunnel.stop', 'server.stop']);
    assert.equal(harness.session.getState().status, 'idle');
});

test('a keep-awake that throws on release still stops everything and reports the state', async () => {
    const harness = createHarness();
    await startHosting(harness);
    harness.keepAwake.stop = () => {
        throw new Error('powerSaveBlocker gone');
    };

    await assert.rejects(harness.session.stop(), /powerSaveBlocker gone/);

    assert.equal(harness.tunnels[0].stopCount, 1);
    assert.equal(harness.servers[0].stopCount, 1);
    assert.deepEqual(harness.statuses.slice(-2), ['stopping', 'idle']);
});

test('stop from failed with a throwing state listener rejects instead of throwing', async () => {
    const harness = createHarness();
    await startHosting(harness);
    harness.servers[0].exitUnexpectedly(1);
    await flush();
    harness.session.on('state', () => {
        throw new Error('Object has been destroyed');
    });

    let stopped;
    assert.doesNotThrow(() => {
        stopped = harness.session.stop();
    });
    await assert.rejects(stopped, /Object has been destroyed/);
    assert.equal(harness.session.getState().status, 'idle');
});

test('a crash with a throwing state listener still tears everything down', async () => {
    const harness = createHarness();
    await startHosting(harness);
    harness.session.on('state', (snapshot) => {
        if (snapshot.status === 'stopping') {
            throw new Error('Object has been destroyed');
        }
    });

    assert.doesNotThrow(() => harness.servers[0].exitUnexpectedly(1));
    await flush();

    assert.equal(harness.tunnels[0].stopCount, 1);
    assert.equal(harness.servers[0].stopCount, 1);
    assert.equal(harness.session.getState().status, 'failed');
});

test('when both stops fail, the error keeps both causes', async () => {
    const harness = createHarness();
    await startHosting(harness);
    harness.tunnels[0].stopError = new Error('tunnel kill failed');
    harness.servers[0].stopError = new Error('server kill failed');

    const error = await harness.session.stop().then(() => null, (reason) => reason);

    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map((cause) => cause.message), ['tunnel kill failed', 'server kill failed']);
});

test('a failure teardown that cannot stop a child adds that to the error', async () => {
    const harness = createHarness();
    await startHosting(harness);
    harness.tunnels[0].stopError = new Error('tunnel kill failed');

    harness.servers[0].exitUnexpectedly(1);
    await flush();

    const snapshot = harness.session.getState();
    assert.equal(snapshot.status, 'failed');
    assert.match(snapshot.error, /stopped unexpectedly/);
    assert.match(snapshot.error, /tunnel kill failed/);
});

test('a cleanup failure after stop() took over the teardown is left to stop()', async () => {
    const harness = createHarness();
    await startHosting(harness);
    harness.tunnels[0].stopError = new Error('tunnel kill failed');

    harness.servers[0].exitUnexpectedly(1);
    await assert.rejects(harness.session.stop(), /tunnel kill failed/);
    await flush();

    assert.equal(harness.session.getState().status, 'idle');
    assert.equal(harness.session.getState().error, null);
});

test('a failing teardown still lets a pending start resolve', async () => {
    const harness = createHarness();

    const started = harness.session.start();
    await flush();
    harness.servers[0].succeed();
    await flush();
    harness.tunnels[0].stopError = new Error('kill failed');
    harness.session.stop().catch(() => {});

    assert.equal((await started).status, 'idle');
});

// --- Room stats (X66) ----------------------------------------------------------------------

function recordRoomStats(session) {
    const received = [];
    session.on('room-stats', (stats) => received.push(stats));
    return received;
}

test('the running server\'s room stats are passed on', async () => {
    const harness = createHarness();
    const received = recordRoomStats(harness.session);
    await startHosting(harness);
    const stats = { playersOnline: 3, roomsLive: 1, rooms: [] };

    harness.servers[0].emit('room-stats', stats);

    assert.deepEqual(received, [stats]);
});

test('stopping reports null, and a stopping server\'s late stats are dropped', async () => {
    const harness = createHarness();
    const received = recordRoomStats(harness.session);
    await startHosting(harness);

    const stopped = harness.session.stop();
    harness.servers[0].emit('room-stats', { playersOnline: 1 });
    await stopped;

    assert.deepEqual(received, [null]);
});

test('a server crash reports null', async () => {
    const harness = createHarness();
    const received = recordRoomStats(harness.session);
    await startHosting(harness);

    harness.servers[0].exitUnexpectedly(1);
    await flush();

    assert.deepEqual(received, [null]);
});

test('stats from a previous run\'s server are dropped', async () => {
    const harness = createHarness();
    const received = recordRoomStats(harness.session);
    await startHosting(harness);
    await harness.session.stop();
    await startHosting(harness);

    harness.servers[0].emit('room-stats', { playersOnline: 1 });

    assert.deepEqual(received, [null]);
});

// --- Quit cleanup --------------------------------------------------------------------------

class FakeApp extends EventEmitter {
    constructor() {
        super();
        this.quitCount = 0;
    }

    quit() {
        this.quitCount += 1;
        const event = {
            defaultPrevented: false,
            preventDefault() {
                this.defaultPrevented = true;
            },
        };
        this.emit('before-quit', event);
        this.lastQuitEvent = event;
    }
}

/** A hosting session as far as quit cleanup sees it: a status, and stop() that ends idle. */
function createQuitHarness(stop = async () => {}) {
    const app = new FakeApp();
    const signals = new EventEmitter();
    const session = {
        /** @type {import('../src/main/hostingSession.js').HostingStatus} */
        status: 'hosting',
        stopCount: 0,
        getState() {
            return { status: this.status };
        },
        stop() {
            this.stopCount += 1;
            this.status = 'idle';
            return stop();
        },
    };
    return { app, signals, session };
}

/** A confirmQuit() whose answer the test gives later. */
function createPrompt() {
    const prompt = {
        asked: 0,
        /** @type {(confirmed: boolean) => void} */
        answer: () => {},
        /** @type {() => Promise<boolean>} */
        confirmQuit: async () => false,
    };
    prompt.confirmQuit = () => {
        prompt.asked += 1;
        return new Promise((resolve) => {
            prompt.answer = resolve;
        });
    };
    return prompt;
}

test('before-quit is held until the session has stopped, then the app quits', async () => {
    const { app, signals, session } = createQuitHarness();
    installQuitCleanup({ session, app, signalTarget: signals });

    app.quit();
    assert.equal(app.lastQuitEvent.defaultPrevented, true);
    await flush();

    assert.equal(session.stopCount, 1);
    assert.equal(app.quitCount, 2);
    assert.equal(app.lastQuitEvent.defaultPrevented, false);
});

test('closing every window quits through the same cleanup', async () => {
    const { app, signals, session } = createQuitHarness();
    installQuitCleanup({ session, app, signalTarget: signals });

    app.emit('window-all-closed');
    await flush();

    assert.equal(session.stopCount, 1);
    assert.equal(app.quitCount, 2);
});

test('process signals stop the session, then quit once', async () => {
    const { app, signals, session } = createQuitHarness();
    installQuitCleanup({ session, app, signalTarget: signals });

    signals.emit('SIGTERM');
    await flush();

    assert.equal(session.stopCount, 1);
    assert.equal(app.quitCount, 1);
    assert.equal(app.lastQuitEvent.defaultPrevented, false);
    assert.equal(signals.listenerCount('SIGINT'), 1);
    assert.equal(signals.listenerCount('SIGHUP'), 1);
});

test('a stop that throws synchronously is reported and the app still quits', async () => {
    const errors = [];
    const { app, session } = createQuitHarness();
    session.stop = () => {
        throw new Error('Object has been destroyed');
    };
    installQuitCleanup({ session, app, onError: (error) => errors.push(String(error)) });

    assert.doesNotThrow(() => app.quit());
    await flush();

    assert.deepEqual(errors, ['Error: Object has been destroyed']);
    assert.equal(app.quitCount, 2);
    assert.equal(app.lastQuitEvent.defaultPrevented, false);
});

test('a quit while idle or failed goes straight through without asking', async () => {
    const prompt = createPrompt();
    const { app, session } = createQuitHarness();
    installQuitCleanup({ session, app, confirmQuit: prompt.confirmQuit });

    for (const status of /** @type {const} */ (['idle', 'failed'])) {
        session.status = status;
        app.quit();
        assert.equal(app.lastQuitEvent.defaultPrevented, false);
    }

    assert.equal(prompt.asked, 0);
    assert.equal(session.stopCount, 0);
});

test('quitting while hosting asks first, then stops and quits on yes', async () => {
    const prompt = createPrompt();
    const { app, session } = createQuitHarness();
    installQuitCleanup({ session, app, confirmQuit: prompt.confirmQuit });

    app.quit();
    assert.equal(app.lastQuitEvent.defaultPrevented, true);
    await flush();
    assert.equal(prompt.asked, 1);
    assert.equal(session.stopCount, 0);

    prompt.answer(true);
    await flush();

    assert.equal(session.stopCount, 1);
    assert.equal(app.quitCount, 2);
    assert.equal(app.lastQuitEvent.defaultPrevented, false);
});

test('declining the prompt keeps hosting, and the next quit asks again', async () => {
    const prompt = createPrompt();
    const { app, session } = createQuitHarness();
    installQuitCleanup({ session, app, confirmQuit: prompt.confirmQuit });

    app.quit();
    await flush();
    prompt.answer(false);
    await flush();

    assert.equal(session.stopCount, 0);
    assert.equal(app.quitCount, 1);

    app.quit();
    await flush();
    assert.equal(prompt.asked, 2);
    assert.equal(app.lastQuitEvent.defaultPrevented, true);
});

test('Cmd+Q, menu Quit and closing every window share one open prompt', async () => {
    const prompt = createPrompt();
    const { app, session } = createQuitHarness();
    installQuitCleanup({ session, app, confirmQuit: prompt.confirmQuit });

    app.quit();
    app.emit('window-all-closed');
    app.quit();
    assert.equal(app.lastQuitEvent.defaultPrevented, true);
    await flush();
    assert.equal(prompt.asked, 1);

    prompt.answer(true);
    await flush();

    assert.equal(session.stopCount, 1);
    assert.equal(app.quitCount, 4);
});

test('a quit during the stop is held, not let through early', async () => {
    /** @type {() => void} */
    let finishStop = () => {};
    const { app, session } = createQuitHarness(() => new Promise((resolve) => {
        finishStop = resolve;
    }));
    installQuitCleanup({ session, app });

    app.quit();
    await flush();
    app.quit();
    assert.equal(app.lastQuitEvent.defaultPrevented, true);

    finishStop();
    await flush();

    assert.equal(session.stopCount, 1);
    assert.equal(app.lastQuitEvent.defaultPrevented, false);
});

test('a prompt that fails is reported and counts as yes', async () => {
    const errors = [];
    const { app, session } = createQuitHarness();
    const confirmQuit = async () => {
        throw new Error('dialog failed');
    };
    installQuitCleanup({ session, app, confirmQuit, onError: (error) => errors.push(String(error)) });

    app.quit();
    await flush();

    assert.deepEqual(errors, ['Error: dialog failed']);
    assert.equal(session.stopCount, 1);
    assert.equal(app.quitCount, 2);
});

test('a signal quits without asking, even while the prompt is open', async () => {
    const prompt = createPrompt();
    const { app, signals, session } = createQuitHarness();
    installQuitCleanup({ session, app, signalTarget: signals, confirmQuit: prompt.confirmQuit });

    app.quit();
    await flush();
    signals.emit('SIGINT');
    await flush();

    assert.equal(session.stopCount, 1);
    assert.equal(app.quitCount, 2);
    assert.equal(app.lastQuitEvent.defaultPrevented, false);

    prompt.answer(true);
    await flush();
    assert.equal(session.stopCount, 1);
    assert.equal(app.quitCount, 2);
});

test('a signal while idle quits without asking', async () => {
    const prompt = createPrompt();
    const { app, signals, session } = createQuitHarness();
    session.status = 'idle';
    installQuitCleanup({ session, app, signalTarget: signals, confirmQuit: prompt.confirmQuit });

    signals.emit('SIGTERM');
    await flush();

    assert.equal(prompt.asked, 0);
    assert.equal(app.quitCount, 1);
});

test('after a quit that was cancelled later, hosting again is stopped on the next quit', async () => {
    const { app, session } = createQuitHarness();
    installQuitCleanup({ session, app });

    app.quit();
    await flush();
    assert.equal(session.stopCount, 1);

    // Something else cancelled the re-issued quit; the user hosts again and then quits.
    session.status = 'hosting';
    app.quit();
    assert.equal(app.lastQuitEvent.defaultPrevented, true);
    await flush();

    assert.equal(session.stopCount, 2);
});

test('a failed stop is reported and the app still quits', async () => {
    const errors = [];
    const { app, signals, session } = createQuitHarness(async () => {
        throw new Error('kill failed');
    });
    installQuitCleanup({ session, app, signalTarget: signals, onError: (error) => errors.push(String(error)) });

    app.quit();
    await flush();

    assert.deepEqual(errors, ['Error: kill failed']);
    assert.equal(app.quitCount, 2);
});

test('the default error report goes to the console', async (t) => {
    const logged = [];
    t.mock.method(console, 'error', (...args) => logged.push(args));
    const { app, session } = createQuitHarness(async () => {
        throw new Error('kill failed');
    });
    installQuitCleanup({ session, app });

    app.quit();
    await flush();

    assert.equal(logged.length, 1);
    assert.equal(app.quitCount, 2);
});

test('the returned function removes every listener it added', () => {
    const { app, signals, session } = createQuitHarness();
    const uninstall = installQuitCleanup({ session, app, signalTarget: signals, signals: ['SIGINT'] });

    uninstall();

    assert.equal(app.listenerCount('before-quit'), 0);
    assert.equal(app.listenerCount('window-all-closed'), 0);
    assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('without a signal target only the app events are watched', () => {
    const { app, session } = createQuitHarness();

    const uninstall = installQuitCleanup({ session, app });
    uninstall();

    assert.equal(app.listenerCount('before-quit'), 0);
});
