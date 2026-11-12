import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';

// Shared test utilities (this file contains no tests of its own).

export const silentLogger = {
    log() {},
    info() {},
    warn() {},
    error() {},
};

/**
 * Starts the app on an ephemeral port with a fresh temp DATA_DIR, or with
 * `dataDir` to reopen an existing one (a restart). `env` overrides environment
 * variables; `keySet`, `geminiFetch`, `now`, `realtimeNow`, `eventLogLimit`,
 * `voteHoldMs`, `launcherPort` (null by default), `launcherReportDelayMs` and `roomSweepNow`
 * are passed to createServer. `instance.close()` stops the server but keeps
 * the DATA_DIR; `stop()` also deletes it.
 */
export async function startTestServer({
    env = {},
    keySet,
    geminiFetch,
    now,
    realtimeNow,
    eventLogLimit,
    voteHoldMs,
    launcherPort = null,
    launcherReportDelayMs,
    roomSweepNow,
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-test-')),
} = {}) {
    const config = loadConfig({
        AUTH_MODE: 'dev',
        SESSION_SECRET: 'test-secret',
        // Many tests set up state through generic entity writes, so they run unlocked;
        // lockdown.test.js turns the flag on.
        LOCK_GAME_ENTITIES: 'false',
        // Tests sign in admins through the dev login, which is only safe off the network (X89).
        DEV_ALLOW_ADMINS: 'true',
        DATA_DIR: dataDir,
        STATIC_DIR: path.join(dataDir, 'no-static'),
        ...env,
    });
    const instance = createServer(config, {
        keySet,
        geminiFetch,
        now,
        realtimeNow,
        eventLogLimit,
        voteHoldMs,
        launcherPort,
        launcherReportDelayMs,
        roomSweepNow,
        logger: silentLogger,
    });

    await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
    const port = instance.server.address().port;

    return {
        instance,
        dataDir,
        baseUrl:`http://127.0.0.1:${port}`,
        wsUrl: `ws://127.0.0.1:${port}/api/realtime`,
        async stop() {
            await instance.close();
            fs.rmSync(dataDir, { recursive: true, force: true });
        },
    };
}

/** Logs in through the dev form and returns the "name=value" cookie string. */
export async function devLogin(baseUrl, email, fullName = '') {
    const response = await fetch(`${baseUrl}/login`, {
        method: 'POST',
        redirect: 'manual',
        body: new URLSearchParams({ email, full_name: fullName, from_url: '/' }),
    });
    const setCookie = response.headers.get('set-cookie');
    if (!setCookie) {
        throw new Error(`Login failed with status ${response.status}`);
    }
    return setCookie.split(';')[0];
}

/** fetch wrapper: JSON body in, { status, body } out. */
export async function api(baseUrl, method, urlPath, { cookie, body, headers = {} } = {}) {
    const requestHeaders = { ...headers };
    if (cookie) {
        requestHeaders.cookie = cookie;
    }

    let payload;
    if (body !== undefined) {
        requestHeaders['content-type'] = 'application/json';
        payload = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const response = await fetch(`${baseUrl}${urlPath}`, { method, headers: requestHeaders, body: payload });
    const text = await response.text();
    let parsed = text;
    try {
        parsed = JSON.parse(text);
    } catch {
        // Non-JSON bodies (HTML) are returned as text.
    }
    return { status: response.status, body: parsed, headers: response.headers };
}

// --- WebSocket client ----------------------------------------------------

/**
 * An append-only list of received messages that can be searched and awaited.
 * `log.messages` is the history in arrival order. `log.waitFor(predicate,
 * { from })` resolves with the first message at index `from` or later that
 * matches, waiting for it when none has arrived yet; it rejects after
 * `timeoutMs`. Waiting doesn't consume anything, so several waits may look at
 * the same message.
 */
export function createMessageLog() {
    const messages = [];
    const watchers = new Set();

    return {
        messages,
        push(message) {
            messages.push(message);
            for (const watcher of [...watchers]) {
                watcher();
            }
        },
        waitFor(predicate, { from = 0, timeoutMs = 2000 } = {}) {
            return new Promise((resolve, reject) => {
                const watcher = { index: from, predicate, resolve, reject, watchers, messages };
                watcher.timer = setTimeout(() => {
                    watchers.delete(scan);
                    reject(new Error('Timed out waiting for a matching message'));
                }, timeoutMs);
                const scan = () => scanForMatch(watcher, scan);
                watchers.add(scan);
                scan();
            });
        },
    };
}

/** Checks the messages a waitFor hasn't seen yet; settles it on the first match. */
function scanForMatch(watcher, scan) {
    while (watcher.index < watcher.messages.length) {
        const message = watcher.messages[watcher.index];
        watcher.index += 1;
        if (watcher.predicate(message)) {
            clearTimeout(watcher.timer);
            watcher.watchers.delete(scan);
            watcher.resolve(message);
            return;
        }
    }
}

/**
 * Opens a WebSocket and queues incoming JSON messages.
 * `client.next()` resolves with the next message (rejects after a timeout);
 * `client.expectSilence(ms)` asserts that nothing arrives.
 * Messages whose type is in `ignoreTypes` are dropped, for tests that aren't
 * about them (e.g. `vote` states in presence tests).
 * Separately from the queue, `client.log` records every message (ignored
 * types too) for tests that look at the whole history; see createMessageLog.
 */
export function connectRealtime(wsUrl, cookie, { ignoreTypes = [] } = {}) {
    const socket = new WebSocket(wsUrl, { headers: { cookie } });
    const queue = [];
    const waiters = [];
    const log = createMessageLog();

    socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        log.push(message);
        if (ignoreTypes.includes(message.type)) {
            return;
        }
        const waiter = waiters.shift();
        if (waiter) {
            waiter(message);
        } else {
            queue.push(message);
        }
    });

    const opened = new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });

    return {
        socket,
        opened,
        log,
        send(message) {
            socket.send(JSON.stringify(message));
        },
        next(timeoutMs = 2000) {
            if (queue.length > 0) {
                return Promise.resolve(queue.shift());
            }
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Timed out waiting for message')), timeoutMs);
                waiters.push((message) => {
                    clearTimeout(timer);
                    resolve(message);
                });
            });
        },
        /** Skips messages of other types until one of `type` arrives. */
        async nextOfType(type, timeoutMs = 2000) {
            let message = await this.next(timeoutMs);
            while (message.type !== type) {
                message = await this.next(timeoutMs);
            }
            return message;
        },
        async expectSilence(ms = 150) {
            await new Promise((resolve) => setTimeout(resolve, ms));
            if (queue.length > 0) {
                throw new Error(`Unexpected message: ${JSON.stringify(queue[0])}`);
            }
        },
        /** Closes the socket; resolves once the close has completed. */
        close() {
            if (socket.readyState === WebSocket.CLOSED) {
                return Promise.resolve();
            }
            const closed = new Promise((resolve) => socket.once('close', resolve));
            socket.close();
            return closed;
        },
    };
}

/** Attempts an upgrade and resolves with the HTTP status of the rejection. */
export function attemptUpgrade(wsUrl, headers = {}) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(wsUrl, { headers });
        socket.on('unexpected-response', (request, response) => {
            resolve(response.statusCode);
            request.destroy();
        });
        socket.on('open', () => {
            socket.close();
            reject(new Error('Upgrade unexpectedly succeeded'));
        });
        socket.on('error', () => {
            // Follows unexpected-response once the request is destroyed; ignore.
        });
    });
}

// --- Simulated players ---------------------------------------------------

/**
 * Where a socket is in the event stream, the way the client tracks it: the
 * epoch and seq of `ready`, then the seq of every event after it. Replayed
 * events arrive before ready and are covered by its seq. Returns
 * { epoch, lastSeq }, both null before ready.
 */
export function socketPosition(client) {
    let epoch = null;
    let lastSeq = null;
    for (const message of client.log.messages) {
        if (message.type === 'ready') {
            epoch = message.epoch;
            lastSeq = message.seq;
        } else if (message.type === 'event' && lastSeq !== null) {
            lastSeq = Math.max(lastSeq, message.seq);
        }
    }
    return { epoch, lastSeq };
}

/**
 * A signed-in user that talks REST and realtime the way the app does. Create
 * one with `await TestPlayer.login(server, name)` (email `name@example.com`).
 * `server` may be reassigned after a restart; the cookie stays valid because
 * the session secret is fixed. `client` is the player's current socket (from
 * connect), and `position` survives reconnects like the client's stored
 * epoch / last_seq.
 */
export class TestPlayer {
    static async login(server, name) {
        const email = `${name}@example.com`;
        const cookie = await devLogin(server.baseUrl, email, name);
        return new TestPlayer(server, name, email, cookie);
    }

    constructor(server, name, email, cookie) {
        this.server = server;
        this.name = name;
        this.email = email;
        this.cookie = cookie;
        this.client = null;
        this.savedPosition = { epoch: null, lastSeq: null };
    }

    get position() {
        if (this.client) {
            return socketPosition(this.client);
        }
        return this.savedPosition;
    }

    /** POST /api/rooms; resolves with { status, body }. */
    createRoom(body) {
        return api(this.server.baseUrl, 'POST', '/api/rooms', { cookie: this.cookie, body });
    }

    /** Runs a game action; resolves with { status, body }. */
    action(roomId, name, body = {}) {
        return api(this.server.baseUrl, 'POST', `/api/rooms/${roomId}/actions/${name}`, {
            cookie: this.cookie,
            body,
        });
    }

    /**
     * Opens an extra socket and says hello with `rooms` and `position`
     * (default: none). Resolves with the client once ready has arrived. The
     * player's `client` is left alone.
     */
    async openSocket(rooms, position = { epoch: null, lastSeq: null }) {
        const client = connectRealtime(this.server.wsUrl, this.cookie);
        await client.opened;
        client.send({ type: 'hello', epoch: position.epoch, last_seq: position.lastSeq, rooms });
        await client.log.waitFor((message) => message.type === 'ready');
        return client;
    }

    /** Opens the player's socket, resuming from its stored position unless `position` is given. */
    async connect(rooms, position = this.position) {
        await this.disconnect();
        this.client = await this.openSocket(rooms, position);
        return this.client;
    }

    /** Closes the player's socket and keeps its position for the next connect. */
    async disconnect() {
        if (!this.client) {
            return;
        }
        this.savedPosition = socketPosition(this.client);
        const client = this.client;
        this.client = null;
        await client.close();
    }

    /** Sends the app-level liveness ping and waits for its pong. */
    async ping(client = this.client) {
        const from = client.log.messages.length;
        client.send({ type: 'ping' });
        await client.log.waitFor((message) => message.type === 'pong', { from });
    }

    /** Waits for a message on the player's socket; see createMessageLog. */
    waitFor(predicate, options) {
        return this.client.log.waitFor(predicate, options);
    }

    /**
     * Waits until the socket has the GameRoom event of the action that brought
     * the room to `version`. An action's events share its room_version and the
     * GameRoom update is published last, so the whole action has arrived.
     */
    waitForRoomVersion(roomId, version) {
        return this.waitFor((message) => {
            return message.type === 'event'
                && message.entity === 'GameRoom'
                && message.event.id === roomId
                && message.room_version >= version;
        });
    }
}
