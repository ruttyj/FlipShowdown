import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { createTunnelProcess } from '../src/main/tunnelProcess.js';

const TUNNEL_URL = 'https://calm-river-1234.trycloudflare.com';
const URL_BOX_LINE = `INF |  ${TUNNEL_URL}  |\n`;
const READY_LINE = 'INF Registered tunnel connection connIndex=0 location=ams01\n';

// --- Fakes ---

/**
 * Stands in for a cloudflared ChildProcess: exit/error events, piped output and kill(). A
 * stubborn child ignores SIGTERM (cloudflared's grace period) and dies only on SIGKILL; an
 * unkillable one ignores both.
 */
class FakeChild extends EventEmitter {
    constructor({ stubborn = false, unkillable = false } = {}) {
        super();
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
        this.killCount = 0;
        this.signals = [];
        this.stubborn = stubborn;
        this.unkillable = unkillable;
        this.pid = 4242;
    }

    kill(signal = 'SIGTERM') {
        this.killCount += 1;
        this.signals.push(signal);
        const ignores = this.unkillable || (this.stubborn && signal !== 'SIGKILL');
        if (!ignores) {
            setImmediate(() => this.emit('exit', null, signal));
        }
        return true;
    }

    exitWith(code) {
        this.emit('exit', code, null);
    }
}

function createTunnel(options = {}, childOptions = {}) {
    const calls = [];
    const spawn = (command, args, spawnOptions) => {
        const child = new FakeChild(childOptions);
        calls.push({ command, args, spawnOptions, child });
        return child;
    };
    const tunnel = createTunnelProcess({
        spawn,
        binaryPath: '/res/cloudflared',
        port: 7007,
        readyTimeoutMs: 200,
        stopTimeoutMs: 50,
        ...options,
    });
    const states = [];
    tunnel.on('state', (state) => states.push(state));
    return { tunnel, calls, states };
}

// --- Start ---

test('start spawns a quick tunnel to the local port', () => {
    const { tunnel, calls } = createTunnel();

    tunnel.start().catch(() => {});

    assert.equal(calls[0].command, '/res/cloudflared');
    assert.deepEqual(calls[0].args, [
        'tunnel', '--no-autoupdate', '--grace-period', '1s', '--url', 'http://127.0.0.1:7007',
    ]);
    assert.equal(calls[0].spawnOptions.windowsHide, true);
    tunnel.stop();
});

test('start emits the URL, then resolves with it once the tunnel is ready', async () => {
    const { tunnel, calls, states } = createTunnel();
    const events = [];
    tunnel.on('url', (url) => events.push(['url', url]));
    tunnel.on('ready', (url) => events.push(['ready', url]));

    const starting = tunnel.start();
    calls[0].child.stderr.write('INF Starting tunnel\n');
    calls[0].child.stderr.write(URL_BOX_LINE);
    calls[0].child.stderr.write(READY_LINE);

    assert.equal(await starting, TUNNEL_URL);
    assert.deepEqual(events, [['url', TUNNEL_URL], ['ready', TUNNEL_URL]]);
    assert.deepEqual(states, ['starting', 'ready']);
    assert.equal(tunnel.url, TUNNEL_URL);
    await tunnel.stop();
});

test('a readiness line before the URL waits for the URL', async () => {
    const { tunnel, calls } = createTunnel();

    const starting = tunnel.start();
    calls[0].child.stdout.write(READY_LINE);
    calls[0].child.stdout.write(URL_BOX_LINE);

    assert.equal(await starting, TUNNEL_URL);
    await tunnel.stop();
});

test('an exit before ready fails start and puts the tunnel in error', async () => {
    const { tunnel, calls, states } = createTunnel();

    const starting = tunnel.start();
    calls[0].child.stderr.write(URL_BOX_LINE);
    calls[0].child.exitWith(1);

    await assert.rejects(starting, /exited with code 1 before it was ready/);
    assert.equal(tunnel.state, 'error');
    assert.deepEqual(states, ['starting', 'error']);
});

test('a spawn error (missing binary) fails start', async () => {
    const { tunnel, calls } = createTunnel();

    const starting = tunnel.start();
    // A child whose spawn failed never got a pid and never exits.
    calls[0].child.pid = undefined;
    calls[0].child.emit('error', new Error('spawn ENOENT'));

    await assert.rejects(starting, /ENOENT/);
    assert.equal(tunnel.state, 'error');
    await tunnel.stop();
    assert.equal(calls[0].child.killCount, 0);
});

test('a spawn that throws synchronously returns a rejected start and puts the tunnel in error', async () => {
    const tunnel = createTunnelProcess({
        spawn: () => {
            throw new Error('spawn UNKNOWN');
        },
        binaryPath: '/res/cloudflared',
        port: 7007,
    });

    /** @type {Promise<string> | undefined} */
    let starting;
    assert.doesNotThrow(() => {
        starting = tunnel.start();
    });

    await assert.rejects(starting, /spawn UNKNOWN/);
    assert.equal(tunnel.state, 'error');
});

test('a timed-out start whose child ignores SIGTERM is force-killed, and stop() waits for it', async () => {
    const { tunnel, calls } = createTunnel({}, { stubborn: true });

    await assert.rejects(tunnel.start(), /not ready within/);
    await tunnel.stop();

    assert.deepEqual(calls[0].child.signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(tunnel.state, 'error');
});

test('a tunnel that never becomes ready times out and is killed', async () => {
    const { tunnel, calls } = createTunnel();

    await assert.rejects(tunnel.start(), /not ready within/);

    assert.equal(tunnel.state, 'error');
    assert.equal(calls[0].child.killCount, 1);
});

test('start twice is refused while a tunnel is running', async () => {
    const { tunnel, calls } = createTunnel();
    const starting = tunnel.start();
    calls[0].child.stderr.write(URL_BOX_LINE + READY_LINE);
    await starting;

    await assert.rejects(tunnel.start(), /already/);
    await tunnel.stop();
});

// --- Exit after ready ---

test('an exit after ready emits an unexpected exit event (retry is the session\'s job)', async () => {
    const { tunnel, calls, states } = createTunnel();
    const exits = [];
    tunnel.on('exit', (exit) => exits.push(exit));
    const starting = tunnel.start();
    calls[0].child.stderr.write(URL_BOX_LINE + READY_LINE);
    await starting;

    calls[0].child.exitWith(1);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(exits, [{ code: 1, expected: false }]);
    assert.equal(tunnel.state, 'exited');
    assert.deepEqual(states, ['starting', 'ready', 'exited']);
});

test('a child error after ready leaves the running tunnel alone', async () => {
    const { tunnel, calls } = createTunnel();
    const starting = tunnel.start();
    calls[0].child.stderr.write(URL_BOX_LINE + READY_LINE);
    await starting;

    calls[0].child.emit('error', new Error('EPIPE'));

    assert.equal(tunnel.state, 'ready');
    assert.equal(calls[0].child.killCount, 0);
    await tunnel.stop();
});

// --- Logs ---

test('output lines are kept in a ring buffer and emitted as log events', async () => {
    const { tunnel, calls } = createTunnel({ maxLogLines: 2 });
    const logged = [];
    tunnel.on('log', (line) => logged.push(line));

    const starting = tunnel.start();
    calls[0].child.stderr.write('INF one\n' + URL_BOX_LINE + READY_LINE);
    await starting;

    assert.equal(logged.length, 3);
    assert.deepEqual(tunnel.logLines, [URL_BOX_LINE.trimEnd(), READY_LINE.trimEnd()]);
    await tunnel.stop();
});

// --- Stop ---

test('stop kills the child and ends stopped with an expected exit', async () => {
    const { tunnel, calls, states } = createTunnel();
    const exits = [];
    tunnel.on('exit', (exit) => exits.push(exit));
    const starting = tunnel.start();
    calls[0].child.stderr.write(URL_BOX_LINE + READY_LINE);
    await starting;

    await tunnel.stop();

    assert.equal(calls[0].child.killCount, 1);
    assert.equal(tunnel.state, 'stopped');
    assert.deepEqual(states, ['starting', 'ready', 'stopping', 'stopped']);
    assert.deepEqual(exits, [{ code: null, expected: true }]);
});

test('stop during startup rejects the pending start', async () => {
    const { tunnel } = createTunnel();

    const starting = assert.rejects(tunnel.start(), /stopped before it was ready/);
    await tunnel.stop();

    await starting;
    assert.equal(tunnel.state, 'stopped');
});

test('stop is idempotent and safe before start', async () => {
    const { tunnel, calls } = createTunnel();

    await tunnel.stop();
    const starting = tunnel.start();
    calls[0].child.stderr.write(URL_BOX_LINE + READY_LINE);
    await starting;
    await Promise.all([tunnel.stop(), tunnel.stop()]);

    assert.equal(calls[0].child.killCount, 1);
    assert.equal(tunnel.state, 'stopped');
});

test('stop sends SIGKILL to a child that ignores SIGTERM and then ends stopped', async () => {
    const { tunnel, calls } = createTunnel({}, { stubborn: true });
    const exits = [];
    tunnel.on('exit', (exit) => exits.push(exit));
    const starting = tunnel.start();
    calls[0].child.stderr.write(URL_BOX_LINE + READY_LINE);
    await starting;

    await tunnel.stop();

    assert.deepEqual(calls[0].child.signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(tunnel.state, 'stopped');
    assert.deepEqual(exits, [{ code: null, expected: true }]);
});

test('stop ends in error when even SIGKILL does not end the child', async () => {
    const { tunnel, calls } = createTunnel({}, { unkillable: true });
    const starting = tunnel.start();
    calls[0].child.stderr.write(URL_BOX_LINE + READY_LINE);
    await starting;

    await tunnel.stop();

    assert.deepEqual(calls[0].child.signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(tunnel.state, 'error');
});
