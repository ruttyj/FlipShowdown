// Runs the unchanged game server (server/src/index.js) as a child process configured only by
// env (decision 11). In the app `fork` is Electron's utilityProcess.fork; tests pass a fake.
//
// States: idle -> starting -> running -> stopping -> stopped, or error when the health check
// times out, the child dies on its own or even a force kill cannot end it. Events: 'state'
// (state), 'log' (line), 'exit' ({ code, expected }), where expected is true only for an
// exit caused by stop(), and 'room-stats' (stats), which the server sends over the parent port
// (X66).
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_HEALTH_TIMEOUT_MS = 15000;
const DEFAULT_HEALTH_INTERVAL_MS = 250;
// One probe may not eat the whole start budget, so each gets at most this long.
const MAX_HEALTH_PROBE_MS = 2000;
const DEFAULT_STOP_TIMEOUT_MS = 5000;
const DEFAULT_MAX_LOG_LINES = 200;
// A child that prints without ever ending a line must not grow the pending text without bound.
const MAX_PENDING_CHARS = 64 * 1024;
// LAUNCHER_MESSAGE.ROOM_STATS in shared/launcherMessages.js. The packaged launcher can't import
// that file (main lives in app.asar, without shared/), so test/serverProcess.test.js checks this copy.
export const ROOM_STATS_MESSAGE = 'room-stats';

// Server settings the launcher owns (server/src/config.js reads them). A value inherited from the
// launcher's own environment, such as a GEMINI_API_KEY a developer set for `npm run share`, would
// otherwise override what the user chose in Settings.
const SERVER_CONFIG_KEYS = [
    'PORT',
    'DATA_DIR',
    'STATIC_DIR',
    'AUTH_MODE',
    'CF_ACCESS_TEAM_DOMAIN',
    'CF_ACCESS_AUD',
    'SESSION_SECRET',
    'ENTITIES',
    'ADMIN_EMAILS',
    'GEMINI_API_KEY',
    'GEMINI_MODEL',
    'TRUST_PROXY',
    'LOCK_GAME_ENTITIES',
    'HOST_OFFLINE_GRACE_SECONDS',
    'STALE_ROOM_HOURS',
    'NODE_ENV',
];

// --- Log lines -----------------------------------------------------------------------------

/**
 * Turns a stream of text chunks into whole lines. Chunks can end mid-line, so the unfinished
 * tail is held until the next chunk: append('one\ntw') -> ['one'], append('o\n') -> ['two'].
 * The held tail is capped at its last MAX_PENDING_CHARS characters.
 * @returns {(chunk: string) => string[]} returns the lines the chunk completed
 */
export function createLineSplitter() {
    let pending = '';

    return (chunk) => {
        const parts = (pending + chunk).split(/\r?\n/);
        pending = parts.pop().slice(-MAX_PENDING_CHARS);
        return parts;
    };
}

/**
 * A ring buffer of the last `maxLines` output lines, for the launcher's "Show logs" panel.
 * @param {number} maxLines
 */
export function createLineLog(maxLines) {
    const kept = [];

    return {
        /** @param {string} line */
        push(line) {
            kept.push(line);
            if (kept.length > maxLines) {
                kept.shift();
            }
        },
        lines() {
            return [...kept];
        },
    };
}

/**
 * Feeds every line of a child's output stream to `onLine`, including a last line that has no
 * newline (often the crash message itself).
 * @param {NodeJS.ReadableStream | null | undefined} stream
 * @param {(line: string) => void} onLine
 */
export function forwardLines(stream, onLine) {
    if (!stream) {
        return;
    }

    const split = createLineSplitter();
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
        for (const line of split(String(chunk))) {
            onLine(line);
        }
    });
    stream.on('end', () => {
        // A newline completes whatever is still pending; an empty tail adds nothing.
        const [lastLine] = split('\n');
        if (lastLine) {
            onLine(lastLine);
        }
    });
}

/**
 * Resolves with the child's exit code the first time it emits 'exit', and records it in the
 * returned `status` so callers can check synchronously whether the child is already gone.
 * @param {EventEmitter} child
 */
export function trackExit(child) {
    const status = { exited: false, code: /** @type {number | null} */ (null) };
    const exited = new Promise((resolve) => {
        child.once('exit', (code) => {
            status.exited = true;
            status.code = code ?? null;
            resolve(status.code);
        });
    });
    return { status, exited };
}

/**
 * Waits for `exited`, or gives up after `timeoutMs` and resolves null.
 * @param {Promise<number | null>} exited
 * @param {number} timeoutMs
 * @returns {Promise<number | null>}
 */
export function waitForExit(exited, timeoutMs) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        exited.then((code) => {
            clearTimeout(timer);
            resolve(code);
        });
    });
}

/**
 * Ends a child: `kill` first, and when the child has not exited within `timeoutMs`, `forceKill`
 * and wait once more. Resolves whether the child is gone and its exit code (null when unknown).
 * @param {ReturnType<typeof trackExit>} exit
 * @param {{ kill: () => void, forceKill: () => void, timeoutMs: number }} options
 * @returns {Promise<{ exited: boolean, code: number | null }>}
 */
export async function terminateChild(exit, { kill, forceKill, timeoutMs }) {
    if (!exit.status.exited) {
        kill();
        await waitForExit(exit.exited, timeoutMs);
    }
    if (!exit.status.exited) {
        forceKill();
        await waitForExit(exit.exited, timeoutMs);
    }
    return { exited: exit.status.exited, code: exit.status.code };
}

/**
 * The default force kill for a utility process. Its kill() is SIGTERM on macOS/Linux, so this
 * sends SIGKILL by pid (on Windows process.kill terminates the process outright).
 * @param {{ pid?: number }} child
 */
function killByPid(child) {
    try {
        process.kill(/** @type {number} */ (child.pid), 'SIGKILL');
    } catch {
        // No pid or no such process: the child is already gone.
    }
}

// --- Environment ---------------------------------------------------------------------------

/**
 * The server's env: the launcher's base env (PATH, SystemRoot, TEMP and the like) without any
 * server settings of its own, plus everything the server needs. No .env file is read, so this
 * is the whole config. The session secret and Gemini settings are added only when set.
 * @param {{ baseEnv: Record<string, string | undefined>, port: number, dataDir: string,
 *   staticDir: string, sessionSecret?: string, geminiApiKey?: string, geminiModel?: string }} input
 * @returns {Record<string, string | undefined>}
 */
export function buildServerEnv({ baseEnv, port, dataDir, staticDir, sessionSecret, geminiApiKey, geminiModel }) {
    const systemEnv = { ...baseEnv };
    for (const key of SERVER_CONFIG_KEYS) {
        delete systemEnv[key];
    }

    /** @type {Record<string, string | undefined>} */
    const env = {
        ...systemEnv,
        PORT: String(port),
        DATA_DIR: dataDir,
        STATIC_DIR: staticDir,
        // Quick-tunnel URLs are throwaway, so the launcher hosts without passwords (decision 5).
        AUTH_MODE: 'dev',
        LOCK_GAME_ENTITIES: 'true',
        NODE_ENV: 'production',
    };
    if (sessionSecret) {
        env.SESSION_SECRET = sessionSecret;
    }
    if (geminiApiKey) {
        env.GEMINI_API_KEY = geminiApiKey;
    }
    if (geminiModel) {
        env.GEMINI_MODEL = geminiModel;
    }
    return env;
}

// --- Health check --------------------------------------------------------------------------

/** True when /api/health answered OK. A refused connection just means "not listening yet". */
async function isHealthy(fetch, url, timeoutMs) {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * Polls `url` until it answers OK. Throws when the child exits first or `timeoutMs` passes.
 * @param {{ fetch: Function, url: string, timeoutMs: number, intervalMs: number,
 *   exit: ReturnType<typeof trackExit> }} input
 */
async function waitForHealth({ fetch, url, timeoutMs, intervalMs, exit }) {
    const deadline = Date.now() + timeoutMs;
    const exitedEarly = exit.exited.then(() => false);

    while (Date.now() < deadline) {
        if (exit.status.exited) {
            throw new Error(`The server exited with code ${exit.status.code} before it answered /api/health`);
        }

        const probeMs = Math.min(deadline - Date.now(), MAX_HEALTH_PROBE_MS);
        const healthy = await Promise.race([isHealthy(fetch, url, probeMs), exitedEarly]);
        if (healthy) {
            return;
        }

        await delay(intervalMs);
    }
    throw new Error(`The server did not answer /api/health within ${timeoutMs} ms`);
}

// --- Server process ------------------------------------------------------------------------

/**
 * @typedef {object} ServerProcessOptions
 * @property {(modulePath: string, args: string[], options: { env: Record<string, string | undefined>,
 *   cwd: string, stdio: 'pipe' }) => any} fork  utilityProcess.fork or a fake
 * @property {Function} fetch               global fetch or a fake
 * @property {string} entryPath             server/src/index.js
 * @property {string} serverRoot            the server package folder (cwd)
 * @property {string} staticDir             the built client
 * @property {string} dataDir               where SQLite lives
 * @property {number} port
 * @property {Record<string, string | undefined>} [baseEnv]  defaults to process.env
 * @property {string} [sessionSecret]       signs player sessions; without it the server writes its own
 *   to a plain file in dataDir
 * @property {string} [geminiApiKey]
 * @property {string} [geminiModel]
 * @property {number} [healthTimeoutMs]
 * @property {number} [healthIntervalMs]
 * @property {number} [stopTimeoutMs]       how long stop() waits for the exit event, before and
 *   again after the force kill
 * @property {(child: any) => void} [forceKill]  used when kill() did not end the child in time;
 *   defaults to SIGKILL by pid
 * @property {number} [maxLogLines]
 */

export class ServerProcess extends EventEmitter {
    /** @type {ServerProcessOptions} */
    #options;
    #state = 'idle';
    #log;
    /** @type {{ child: any, exit: ReturnType<typeof trackExit> } | null} */
    #current = null;
    /** @type {Promise<void> | null} */
    #stopping = null;
    /**
     * The termination of a child that is no longer current (a failed start or a fatal error)
     * but may still be alive, so stop() can wait for it. Null once it has ended.
     * @type {Promise<void> | null}
     */
    #lingering = null;

    /** @param {ServerProcessOptions} options */
    constructor(options) {
        super();
        this.#options = options;
        this.#log = createLineLog(options.maxLogLines ?? DEFAULT_MAX_LOG_LINES);
    }

    /** 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error' */
    get state() {
        return this.#state;
    }

    /** The last output lines of the server, oldest first. */
    get logLines() {
        return this.#log.lines();
    }

    /** Forks the server and resolves once /api/health answers; rejects (state error) otherwise. */
    async start() {
        if (this.#current) {
            throw new Error('The server is already running');
        }

        this.#setState('starting');
        const current = this.#forkOrFail();
        this.#current = current;

        try {
            await waitForHealth({
                fetch: this.#options.fetch,
                url: `http://127.0.0.1:${this.#options.port}/api/health`,
                timeoutMs: this.#options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
                intervalMs: this.#options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS,
                exit: current.exit,
            });
        } catch (error) {
            this.#failStart(current, error);
        }

        // stop() may have run while the health check was in flight, and a newer start() after it.
        if (this.#wasReplaced(current)) {
            throw new Error('The server was stopped while starting');
        }
        this.#setState('running');
    }

    /**
     * Kills the server (force-killing it when it ignores kill()) and resolves once it has exited.
     * Ends stopped, or error when even the force kill did not end it. Safe to call at any time,
     * repeatedly; with no current server it waits for a failed start's child to be gone.
     */
    stop() {
        if (this.#stopping) {
            return this.#stopping;
        }
        if (!this.#current) {
            return this.#lingering ?? Promise.resolve();
        }

        this.#stopping = this.#stopChild(this.#current).finally(() => {
            this.#stopping = null;
        });
        return this.#stopping;
    }

    /** True when stop() (and maybe a newer start()) took over while `current` was starting. */
    #wasReplaced(current) {
        return this.#current !== current || this.#state !== 'starting';
    }

    /** fork() can throw synchronously (e.g. "spawn UNKNOWN" when antivirus blocks it). */
    #forkOrFail() {
        try {
            return this.#fork();
        } catch (error) {
            this.#setState('error');
            throw error;
        }
    }

    #fork() {
        const options = this.#options;
        const env = buildServerEnv({
            baseEnv: options.baseEnv ?? process.env,
            port: options.port,
            dataDir: options.dataDir,
            staticDir: options.staticDir,
            sessionSecret: options.sessionSecret,
            geminiApiKey: options.geminiApiKey,
            geminiModel: options.geminiModel,
        });
        const child = options.fork(options.entryPath, [], { env, cwd: options.serverRoot, stdio: 'pipe' });
        const current = { child, exit: trackExit(child) };

        const onLine = (line) => this.#addLogLine(line);
        forwardLines(child.stdout, onLine);
        forwardLines(child.stderr, onLine);
        child.on('message', (message) => this.#handleServerMessage(current, message));
        // Without a listener, a utility-process 'error' would throw in the Electron main process.
        child.on('error', (type, location) => this.#handleFatalError(current, type, location));
        current.exit.exited.then((code) => this.#handleExit(current, code));
        return current;
    }

    /** Room stats from the current server; anything else on the port is ignored. */
    #handleServerMessage(current, message) {
        const isCurrent = this.#current === current;
        const isRoomStats = message?.type === ROOM_STATS_MESSAGE;
        if (!isCurrent || !isRoomStats) {
            return;
        }
        this.emit('room-stats', message.stats);
    }

    /** Cleans up after a failed start and rethrows, unless stop() caused the failure. */
    #failStart(current, error) {
        if (this.#wasReplaced(current)) {
            throw new Error('The server was stopped while starting');
        }

        this.#current = null;
        this.#terminateInBackground(current);
        this.#setState('error');
        throw error;
    }

    /**
     * Electron's UtilityProcess reports a non-recoverable V8 error (type 'FatalError') before it
     * exits. During startup the exit fails the start and during stop() the stop handles it, so
     * only a running server needs moving to error here.
     */
    #handleFatalError(current, type, location) {
        this.#addLogLine(`The server process hit a fatal error: ${type} (${location ?? 'unknown location'})`);

        const isRunning = this.#current === current && this.#state === 'running';
        if (!isRunning) {
            return;
        }

        this.#current = null;
        this.#terminateInBackground(current);
        this.#setState('error');
        this.emit('exit', { code: null, expected: false });
    }

    /** Ends a child that is no longer current, tracked in #lingering so stop() can wait for it. */
    #terminateInBackground(current) {
        const lingering = this.#terminate(current).then(() => {
            if (this.#lingering === lingering) {
                this.#lingering = null;
            }
        });
        this.#lingering = lingering;
    }

    #terminate(current) {
        const forceKill = this.#options.forceKill ?? killByPid;
        return terminateChild(current.exit, {
            kill: () => current.child.kill(),
            forceKill: () => forceKill(current.child),
            timeoutMs: this.#options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
        });
    }

    /** An exit nobody asked for: a crash after start. Startup and stop() handle their own exits. */
    #handleExit(current, code) {
        const isUnexpected = this.#current === current && this.#state === 'running';
        if (!isUnexpected) {
            return;
        }

        this.#current = null;
        this.#setState('error');
        this.emit('exit', { code, expected: false });
    }

    async #stopChild(current) {
        this.#setState('stopping');
        const { exited, code } = await this.#terminate(current);
        this.#current = null;

        if (!exited) {
            this.#addLogLine('The server did not exit, even after a force kill');
            this.#setState('error');
            return;
        }
        this.#setState('stopped');
        this.emit('exit', { code, expected: true });
    }

    #addLogLine(line) {
        this.#log.push(line);
        this.emit('log', line);
    }

    #setState(state) {
        this.#state = state;
        this.emit('state', state);
    }
}

/** @param {ServerProcessOptions} options */
export function createServerProcess(options) {
    return new ServerProcess(options);
}
