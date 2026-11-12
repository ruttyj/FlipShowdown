// Runs a cloudflared quick tunnel to the local server and reports its public URL. In the app
// `spawn` is node:child_process spawn; tests pass a fake.
//
// States: idle -> starting -> ready -> stopping -> stopped. A start that fails (exit, spawn
// error or timeout before ready) ends in error; an exit after ready ends in exited, and
// restarting is the hosting session's job. A stop that cannot end cloudflared even with
// SIGKILL also ends in error. Events: 'state' (state), 'log' (line), 'url' (url),
// 'ready' (url) and 'exit' ({ code, expected }), where expected is true only after stop().
import { EventEmitter } from 'node:events';

import { createLineLog, forwardLines, terminateChild, trackExit } from './serverProcess.js';
import { findTunnelUrl, isTunnelReady } from './tunnelUrl.js';

// scripts/share.mjs waits as long for a quick tunnel.
const DEFAULT_READY_TIMEOUT_MS = 60000;
const DEFAULT_STOP_TIMEOUT_MS = 5000;
const DEFAULT_MAX_LOG_LINES = 200;

/**
 * @typedef {object} TunnelProcessOptions
 * @property {(command: string, args: string[], options: object) => any} spawn  child_process.spawn or a fake
 * @property {string} binaryPath     the cloudflared executable
 * @property {number} port           the local server port to expose
 * @property {number} [readyTimeoutMs]
 * @property {number} [stopTimeoutMs]  how long stop() waits for the exit event, before and
 *   again after SIGKILL
 * @property {number} [maxLogLines]
 */

/**
 * @typedef {object} RunningTunnel
 * @property {any} child
 * @property {ReturnType<typeof trackExit>} exit
 * @property {boolean} sawReady
 * @property {{ resolve: (url: string) => void, reject: (error: Error) => void,
 *   timer: NodeJS.Timeout } | null} startup  pending start(), until ready or failed
 */

/**
 * The cloudflared arguments for a throwaway quick tunnel to 127.0.0.1:port. On SIGTERM
 * cloudflared waits its grace period (30 s by default) for open requests, and the game's
 * WebSockets never finish, so the period is kept short to let stop() end it promptly.
 */
export function buildTunnelArgs(port) {
    return ['tunnel', '--no-autoupdate', '--grace-period', '1s', '--url', `http://127.0.0.1:${port}`];
}

export class TunnelProcess extends EventEmitter {
    /** @type {TunnelProcessOptions} */
    #options;
    #state = 'idle';
    /** @type {string | null} */
    #url = null;
    #log;
    /** @type {RunningTunnel | null} */
    #current = null;
    /** @type {Promise<void> | null} */
    #stopping = null;
    /**
     * The termination of a failed start's child, which may still be alive, so stop() can wait
     * for it. Null once it has ended.
     * @type {Promise<void> | null}
     */
    #lingering = null;

    /** @param {TunnelProcessOptions} options */
    constructor(options) {
        super();
        this.#options = options;
        this.#log = createLineLog(options.maxLogLines ?? DEFAULT_MAX_LOG_LINES);
    }

    /** 'idle' | 'starting' | 'ready' | 'exited' | 'stopping' | 'stopped' | 'error' */
    get state() {
        return this.#state;
    }

    /** The public URL once cloudflared has printed it, else null. */
    get url() {
        return this.#url;
    }

    /** The last output lines of cloudflared, oldest first. */
    get logLines() {
        return this.#log.lines();
    }

    /**
     * Spawns cloudflared and resolves with the public URL once the tunnel can carry traffic.
     * @returns {Promise<string>}
     */
    start() {
        if (this.#current) {
            return Promise.reject(new Error('The tunnel is already running'));
        }

        this.#url = null;
        this.#setState('starting');
        let child;
        try {
            child = this.#spawn();
        } catch (error) {
            // spawn throws synchronously for some errors, e.g. "spawn UNKNOWN" when antivirus
            // blocks the exe; callers expect a rejected promise either way.
            this.#setState('error');
            return Promise.reject(error);
        }
        /** @type {RunningTunnel} */
        const current = { child, exit: trackExit(child), sawReady: false, startup: null };
        this.#current = current;

        const started = this.#awaitStartup(current);
        this.#watchChild(current);
        return started;
    }

    /**
     * Kills cloudflared (SIGKILL when it ignores SIGTERM) and resolves once it has exited. Ends
     * stopped, or error when even SIGKILL did not end it. Safe to call at any time, repeatedly;
     * with no current tunnel it waits for a failed start's child to be gone.
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

    #spawn() {
        const { spawn, binaryPath, port } = this.#options;
        return spawn(binaryPath, buildTunnelArgs(port), {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
    }

    /** kill() is SIGTERM on macOS/Linux (TerminateProcess on Windows); SIGKILL if that is ignored. */
    #terminate(current) {
        return terminateChild(current.exit, {
            kill: () => current.child.kill(),
            forceKill: () => current.child.kill('SIGKILL'),
            timeoutMs: this.#options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
        });
    }

    /** Ends a failed start's child, tracked in #lingering so stop() can wait for it. */
    #terminateInBackground(current) {
        // A child whose spawn failed (e.g. ENOENT) has no pid: no process, and no exit to await.
        if (current.child.pid === undefined) {
            return;
        }

        const lingering = this.#terminate(current).then(() => {
            if (this.#lingering === lingering) {
                this.#lingering = null;
            }
        });
        this.#lingering = lingering;
    }

    /** @param {RunningTunnel} current */
    #awaitStartup(current) {
        const timeoutMs = this.#options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#failStartup(current, new Error(`cloudflared was not ready within ${timeoutMs} ms`));
            }, timeoutMs);
            current.startup = { resolve, reject, timer };
        });
    }

    /** @param {RunningTunnel} current */
    #watchChild(current) {
        // cloudflared logs to stderr, but read both in case a version moves its banner.
        const onLine = (line) => this.#handleLine(current, line);
        forwardLines(current.child.stdout, onLine);
        forwardLines(current.child.stderr, onLine);
        // A spawn error, e.g. ENOENT when the binary is missing.
        current.child.on('error', (error) => this.#failStartup(current, error));
        current.exit.exited.then((code) => this.#handleExit(current, code));
    }

    #handleLine(current, line) {
        this.#log.push(line);
        this.emit('log', line);
        if (current !== this.#current) {
            return;
        }

        if (this.#url === null) {
            this.#url = findTunnelUrl(line);
            if (this.#url !== null) {
                this.emit('url', this.#url);
            }
        }
        if (isTunnelReady(line)) {
            current.sawReady = true;
        }
        this.#finishStartupIfReady(current);
    }

    /** The tunnel is usable only once it has both printed its URL and registered a connection. */
    #finishStartupIfReady(current) {
        const isReady = this.#state === 'starting' && this.#url !== null && current.sawReady;
        if (!isReady) {
            return;
        }

        const { resolve, timer } = current.startup;
        clearTimeout(timer);
        current.startup = null;
        this.#setState('ready');
        this.emit('ready', this.#url);
        resolve(this.#url);
    }

    #failStartup(current, error) {
        const isPendingStart = current === this.#current && current.startup !== null;
        if (!isPendingStart) {
            return;
        }

        const { reject, timer } = current.startup;
        clearTimeout(timer);
        current.startup = null;
        this.#current = null;
        this.#terminateInBackground(current);
        this.#setState('error');
        reject(error);
    }

    /** Exits during startup fail the start; stop() handles its own exit. */
    #handleExit(current, code) {
        if (current !== this.#current || this.#state === 'stopping') {
            return;
        }

        if (current.startup !== null) {
            this.#failStartup(current, new Error(`cloudflared exited with code ${code} before it was ready`));
            return;
        }

        this.#current = null;
        this.#setState('exited');
        this.emit('exit', { code, expected: false });
    }

    async #stopChild(current) {
        this.#setState('stopping');
        if (current.startup !== null) {
            clearTimeout(current.startup.timer);
            current.startup.reject(new Error('The tunnel was stopped before it was ready'));
            current.startup = null;
        }

        const { exited, code } = await this.#terminate(current);
        this.#current = null;
        this.#url = null;

        if (!exited) {
            const line = 'cloudflared did not exit, even after SIGKILL';
            this.#log.push(line);
            this.emit('log', line);
            this.#setState('error');
            return;
        }
        this.#setState('stopped');
        this.emit('exit', { code, expected: true });
    }

    #setState(state) {
        this.#state = state;
        this.emit('state', state);
    }
}

/** @param {TunnelProcessOptions} options */
export function createTunnelProcess(options) {
    return new TunnelProcess(options);
}
