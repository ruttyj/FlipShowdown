// The launcher's "Start hosting" button: picks a port, starts the game server, opens a
// cloudflared quick tunnel to it and keeps the laptop awake while players can reach it. The
// server, tunnel and keep-awake come from injected factories, so tests use fakes.
//
// Status: idle -> starting-server -> starting-tunnel -> hosting <-> tunnel-restarting, and from
// any of those, stopping -> idle (stop()) or stopping -> failed (a crash, a failed start, or the
// tunnel giving up). Failed means everything is already torn down; retry() starts from scratch.
//
// Events:
//   'state'       (snapshot)                every change of the snapshot except log lines
//   'log'         ({ source, line })        a server or tunnel output line ('server' | 'tunnel')
//   'url-changed' ({ previousUrl, url })    a restarted tunnel came up on a new URL, so players
//                                           must rescan (decision 14)
//   'room-stats'  (stats | null)            the running server's players and rooms (X66); null
//                                           once the session stops or fails
import { EventEmitter } from 'node:events';

import {
    DEFAULT_RETRY_POLICY,
    didUrlChange,
    initialRetryState,
    recordConnected,
    recordFailure,
} from './retryPolicy.js';

/** @typedef {import('./retryPolicy.js').RetryPolicy} RetryPolicy */
/** @typedef {import('./retryPolicy.js').RetryState} RetryState */

/**
 * What the session needs from serverProcess. start() resolves once the server answers health
 * checks; stop() is idempotent and rejects a pending start(). 'exit' carries { code, expected }.
 * @typedef {object} ManagedServer
 * @property {() => Promise<void>} start
 * @property {() => Promise<void>} stop
 * @property {string[]} logLines
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} on
 */

/**
 * What the session needs from tunnelProcess: like ManagedServer, but start() resolves with the
 * public URL, and start() may be called again after an unexpected exit.
 * @typedef {object} ManagedTunnel
 * @property {() => Promise<string>} start
 * @property {() => Promise<void>} stop
 * @property {string[]} logLines
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} on
 */

/**
 * @typedef {object} KeepAwake
 * @property {() => void} start
 * @property {() => void} stop
 */

/**
 * @typedef {object} Timers
 * @property {(callback: () => void, ms: number) => unknown} setTimeout
 * @property {(handle: any) => void} clearTimeout
 */

/**
 * @typedef {object} HostingSessionOptions
 * @property {() => Promise<number>} pickPort
 * @property {(input: { port: number }) => ManagedServer} createServer  called once per start
 * @property {(input: { port: number }) => ManagedTunnel} createTunnel  called once per start;
 *   the same tunnel is restarted after drops
 * @property {KeepAwake} keepAwake
 * @property {RetryPolicy} [retryPolicy]  defaults to DEFAULT_RETRY_POLICY
 * @property {() => number} [now]         defaults to Date.now
 * @property {Timers} [timers]            defaults to the global timers
 */

/**
 * @typedef {'idle' | 'starting-server' | 'starting-tunnel' | 'hosting' | 'tunnel-restarting'
 *   | 'stopping' | 'failed'} HostingStatus
 */

/**
 * @typedef {object} RetryInfo  the restart the session is waiting to make
 * @property {number} attempt     1-based
 * @property {number} maxRetries
 * @property {number} delayMs
 */

/**
 * @typedef {object} HostingSnapshot
 * @property {HostingStatus} status
 * @property {number | null} port
 * @property {string | null} url          the live public URL, null while the tunnel is down
 * @property {string | null} previousUrl  the URL before the last change, for the rescan banner
 * @property {string | null} error        why the session failed
 * @property {RetryInfo | null} retry     set while waiting to restart the tunnel
 * @property {string[]} serverLog
 * @property {string[]} tunnelLog
 */

/**
 * One start's worth of state. stop() and failures abort it, which makes every late callback
 * from its server, tunnel or timer a no-op.
 * @typedef {object} Run
 * @property {boolean} aborted
 * @property {RetryState} retryState
 * @property {string | null} lastUrl     the URL players last scanned
 * @property {(() => void) | null} cancelWait  ends a pending backoff early
 * @property {ManagedServer | null} server
 * @property {ManagedTunnel | null} tunnel
 */

/** @type {Timers} */
const GLOBAL_TIMERS = {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle),
};

// --- Helpers -------------------------------------------------------------------------------

/**
 * Statuses in which players can reach the game, or soon will again. Keep-awake covers a
 * tunnel restart too, so a short drop doesn't let the laptop sleep.
 * @param {HostingStatus} status
 */
function isAwakeStatus(status) {
    return status === 'hosting' || status === 'tunnel-restarting';
}

/** @param {unknown} error */
function messageOf(error) {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

/** @returns {Run} */
function createRun() {
    return {
        aborted: false,
        retryState: initialRetryState(),
        lastUrl: null,
        cancelWait: null,
        server: null,
        tunnel: null,
    };
}

/**
 * Stops the tunnel first, so the public URL dies before the server it points at, then the
 * server. The server is stopped even when stopping the tunnel fails; when both fail, the
 * AggregateError keeps both causes.
 * @param {Run | null} run
 */
async function stopProcesses(run) {
    const errors = [];
    try {
        await run?.tunnel?.stop();
    } catch (error) {
        errors.push(error);
    }
    try {
        await run?.server?.stop();
    } catch (error) {
        errors.push(error);
    }

    if (errors.length === 1) {
        throw errors[0];
    }
    if (errors.length > 1) {
        throw new AggregateError(errors, 'Stopping both the tunnel and the server failed');
    }
}

// --- Hosting session -----------------------------------------------------------------------

export class HostingSession extends EventEmitter {
    /** @type {HostingSessionOptions} */
    #options;
    /** @type {RetryPolicy} */
    #policy;
    /** @type {() => number} */
    #now;
    /** @type {Timers} */
    #timers;

    /** @type {HostingStatus} */
    #status = 'idle';
    /** @type {number | null} */
    #port = null;
    /** @type {string | null} */
    #url = null;
    /** @type {string | null} */
    #previousUrl = null;
    /** @type {string | null} */
    #error = null;
    /** @type {RetryInfo | null} */
    #retry = null;

    /** @type {Run | null} */
    #run = null;
    /** @type {Promise<HostingSnapshot> | null} */
    #starting = null;
    /** @type {Promise<void> | null} */
    #stopping = null;
    /** @type {'idle' | 'failed'} */
    #stopTarget = 'idle';
    // Counts stop() calls, so a start queued behind a stop can tell it was cancelled.
    #stopRequests = 0;

    /** @param {HostingSessionOptions} options */
    constructor(options) {
        super();
        this.#options = options;
        this.#policy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
        this.#now = options.now ?? Date.now;
        this.#timers = options.timers ?? GLOBAL_TIMERS;
    }

    /** @returns {HostingSnapshot} */
    getState() {
        const run = this.#run;
        let retry = null;
        if (this.#retry !== null) {
            retry = { ...this.#retry };
        }

        return {
            status: this.#status,
            port: this.#port,
            url: this.#url,
            previousUrl: this.#previousUrl,
            error: this.#error,
            retry,
            serverLog: [...(run?.server?.logLines ?? [])],
            tunnelLog: [...(run?.tunnel?.logLines ?? [])],
        };
    }

    /**
     * Starts hosting. Resolves with the snapshot once the session is hosting, failed, or was
     * stopped; it never rejects, because failures are reported in the state. Calls while
     * starting share one start; a call while stopping starts once the stop has finished.
     * @returns {Promise<HostingSnapshot>}
     */
    start() {
        if (this.#starting) {
            return this.#starting;
        }
        if (isAwakeStatus(this.#status)) {
            return Promise.resolve(this.getState());
        }

        this.#starting = this.#startWhenStopped(this.#stopRequests).finally(() => {
            this.#starting = null;
        });
        return this.#starting;
    }

    /**
     * The error screen's Retry button: starts again from scratch after a failure. Does nothing
     * in any other state.
     * @returns {Promise<HostingSnapshot>}
     */
    retry() {
        if (this.#status === 'failed') {
            return this.start();
        }
        return this.#starting ?? Promise.resolve(this.getState());
    }

    /**
     * Stops hosting: the tunnel first, then the server. Safe in any state, including mid-start
     * (the start is abandoned) and repeatedly (calls during a stop share it). Rejects only when
     * a child could not be stopped, after still trying to stop the other one, or when a 'state'
     * listener or keep-awake throws; it never throws synchronously.
     * @returns {Promise<void>}
     */
    stop() {
        this.#stopRequests += 1;
        if (this.#stopping) {
            this.#stopTarget = 'idle';
            return this.#stopping;
        }
        if (this.#status === 'failed') {
            return this.#resetFromFailed();
        }
        if (this.#status === 'idle') {
            return Promise.resolve();
        }
        return this.#tearDown('idle');
    }

    // --- Starting --------------------------------------------------------------------------

    /** @param {number} stopRequests  stop() calls seen when start() was called */
    async #startWhenStopped(stopRequests) {
        if (this.#stopping) {
            await this.#stopping.catch(() => {});
            if (stopRequests !== this.#stopRequests) {
                return this.getState();
            }
        }

        await this.#host();
        return this.getState();
    }

    async #host() {
        const run = this.#beginRun();
        try {
            await this.#bringUp(run);
        } catch (error) {
            this.#fail(run, error);
        }

        // A stop or failure during the start: resolve start() with where the teardown ends.
        if (this.#stopping) {
            await this.#stopping.catch(() => {});
        }
    }

    /** @param {Run} run */
    async #bringUp(run) {
        this.#setStatus('starting-server');
        const port = await this.#options.pickPort();
        if (run.aborted) {
            return;
        }

        this.#port = port;
        run.server = this.#createServer(run, port);
        await run.server.start();
        if (run.aborted) {
            return;
        }

        this.#setStatus('starting-tunnel');
        run.tunnel = this.#createTunnel(run, port);
        await this.#connectTunnel(run, run.tunnel);
    }

    #beginRun() {
        const run = createRun();
        this.#run = run;
        this.#port = null;
        this.#url = null;
        this.#previousUrl = null;
        this.#error = null;
        this.#retry = null;
        return run;
    }

    /**
     * @param {Run} run
     * @param {number} port
     */
    #createServer(run, port) {
        const server = this.#options.createServer({ port });
        server.on('log', (line) => this.emit('log', { source: 'server', line }));
        server.on('exit', (exit) => this.#handleServerExit(run, exit));
        server.on('room-stats', (stats) => this.#handleRoomStats(run, stats));
        return server;
    }

    /**
     * Passes on the current run's stats. A run being torn down has already reported null.
     * @param {Run} run
     * @param {unknown} stats
     */
    #handleRoomStats(run, stats) {
        if (run !== this.#run || run.aborted) {
            return;
        }
        this.emit('room-stats', stats);
    }

    /**
     * @param {Run} run
     * @param {number} port
     */
    #createTunnel(run, port) {
        const tunnel = this.#options.createTunnel({ port });
        tunnel.on('log', (line) => this.emit('log', { source: 'tunnel', line }));
        tunnel.on('exit', (exit) => this.#handleTunnelExit(run, exit));
        return tunnel;
    }

    // --- Tunnel --------------------------------------------------------------------------------

    /**
     * Starts the tunnel, retrying failed starts per the retry policy. Throws when the policy
     * gives up; returns quietly when the run is aborted.
     * @param {Run} run
     * @param {ManagedTunnel} tunnel
     */
    async #connectTunnel(run, tunnel) {
        while (!run.aborted) {
            let url;
            try {
                url = await tunnel.start();
            } catch (error) {
                if (run.aborted) {
                    return;
                }
                await this.#backOff(run, error);
                continue;
            }

            if (!run.aborted) {
                this.#handleTunnelReady(run, url);
            }
            return;
        }
    }

    /**
     * Counts a tunnel failure and waits out the backoff, or throws when the policy gives up.
     * @param {Run} run
     * @param {unknown} cause
     */
    async #backOff(run, cause) {
        const { state, decision } = recordFailure(run.retryState, this.#now(), this.#policy);
        run.retryState = state;
        if (decision.type === 'give-up') {
            throw new Error(`The tunnel failed ${decision.failures} times in a row. Last error: ${messageOf(cause)}`);
        }

        this.#retry = { attempt: decision.attempt, maxRetries: this.#policy.maxRetries, delayMs: decision.delayMs };
        this.#emitState();
        await this.#wait(run, decision.delayMs);
    }

    /**
     * Resolves after `ms`, or as soon as the run is aborted.
     * @param {Run} run
     * @param {number} ms
     * @returns {Promise<void>}
     */
    #wait(run, ms) {
        return new Promise((resolve) => {
            const handle = this.#timers.setTimeout(() => {
                run.cancelWait = null;
                resolve();
            }, ms);
            run.cancelWait = () => {
                this.#timers.clearTimeout(handle);
                run.cancelWait = null;
                resolve();
            };
        });
    }

    /**
     * @param {Run} run
     * @param {string} url
     */
    #handleTunnelReady(run, url) {
        const previousUrl = run.lastUrl;
        const urlChanged = didUrlChange(previousUrl, url);
        run.retryState = recordConnected(run.retryState, this.#now());
        run.lastUrl = url;

        this.#url = url;
        this.#retry = null;
        if (urlChanged) {
            this.#previousUrl = previousUrl;
        }
        this.#setStatus('hosting');

        if (urlChanged) {
            this.emit('url-changed', { previousUrl, url });
        }
    }

    /**
     * A drop while hosting restarts the tunnel. Exits during a start are handled by the failed
     * start() instead, and exits caused by stop() are expected.
     * @param {Run} run
     * @param {{ code: number | null, expected: boolean }} exit
     */
    #handleTunnelExit(run, { code, expected }) {
        const isDrop = !expected && !run.aborted && this.#status === 'hosting';
        if (!isDrop) {
            return;
        }

        this.#url = null;
        this.#setStatus('tunnel-restarting');
        this.#restartTunnel(run, new Error(`cloudflared exited with code ${code}`));
    }

    /**
     * @param {Run} run
     * @param {Error} cause
     */
    async #restartTunnel(run, cause) {
        try {
            await this.#backOff(run, cause);
            await this.#connectTunnel(run, /** @type {ManagedTunnel} */ (run.tunnel));
        } catch (error) {
            this.#fail(run, error);
        }
    }

    // --- Failure and stopping --------------------------------------------------------------

    /**
     * @param {Run} run
     * @param {{ code: number | null, expected: boolean }} exit
     */
    #handleServerExit(run, { code, expected }) {
        if (expected) {
            return;
        }
        this.#fail(run, new Error(`The game server stopped unexpectedly (exit code ${code})`));
    }

    /**
     * Tears the run down and ends in failed. Ignored for a run that is already stopping, so a
     * crash caused by the teardown isn't reported as the reason.
     * @param {Run} run
     * @param {unknown} error
     */
    #fail(run, error) {
        if (run !== this.#run || run.aborted) {
            return;
        }

        this.#error = messageOf(error);
        // Nobody waits on this teardown, so a cleanup failure is added to the reported error.
        this.#tearDown('failed')
            .catch((cleanupError) => this.#reportCleanupFailure(cleanupError))
            .catch(() => {});
    }

    /** @param {unknown} cleanupError */
    #reportCleanupFailure(cleanupError) {
        // A stop() during the teardown ends in idle, and its caller gets the error instead.
        if (this.#status !== 'failed') {
            return;
        }

        this.#error = `${this.#error}. Stopping it also failed: ${messageOf(cleanupError)}`;
        this.#emitState();
    }

    /**
     * Aborts the current run and stops its processes, then settles in `target`.
     * @param {'idle' | 'failed'} target
     */
    #tearDown(target) {
        const run = this.#run;
        this.#stopTarget = target;
        if (run) {
            run.aborted = true;
            run.cancelWait?.();
        }

        this.#url = null;
        this.#retry = null;
        this.#stopping = this.#stopRun(run).finally(() => {
            this.#stopping = null;
            this.#finishStop(this.#stopTarget);
        });
        return this.#stopping;
    }

    /**
     * Reports 'stopping', then stops the processes. They are stopped even when the report
     * throws (a 'state' listener or keep-awake failing), so children never outlive a stop; the
     * throw then rejects the stop instead.
     * @param {Run | null} run
     */
    async #stopRun(run) {
        try {
            this.#setStatus('stopping');
            // The counts end with the run, so a later start never shows this run's numbers.
            this.emit('room-stats', null);
        } finally {
            await stopProcesses(run);
        }
    }

    // async, so a throwing 'state' listener rejects stop() instead of throwing out of it.
    async #resetFromFailed() {
        this.#finishStop('idle');
    }

    /** @param {'idle' | 'failed'} target */
    #finishStop(target) {
        this.#port = null;
        this.#previousUrl = null;
        if (target === 'idle') {
            this.#error = null;
        }
        this.#setStatus(target);
    }

    // --- State -----------------------------------------------------------------------------

    /**
     * Changes status and keeps keep-awake in step: on when entering hosting, off when leaving.
     * @param {HostingStatus} status
     */
    #setStatus(status) {
        const wasAwake = isAwakeStatus(this.#status);
        const isAwake = isAwakeStatus(status);
        this.#status = status;

        // The new status is reported even when keep-awake throws.
        try {
            if (isAwake && !wasAwake) {
                this.#options.keepAwake.start();
            }
            if (wasAwake && !isAwake) {
                this.#options.keepAwake.stop();
            }
        } finally {
            this.#emitState();
        }
    }

    #emitState() {
        this.emit('state', this.getState());
    }
}

/** @param {HostingSessionOptions} options */
export function createHostingSession(options) {
    return new HostingSession(options);
}

// --- Quit cleanup --------------------------------------------------------------------------

const DEFAULT_QUIT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * @typedef {object} QuitApp  Electron's `app`, or a fake
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} on
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} removeListener
 * @property {() => void} quit
 */

/**
 * @typedef {object} SignalTarget  `process`, or a fake
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} on
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} removeListener
 */

/** @param {unknown} error */
function logCleanupError(error) {
    console.error('Stopping the hosting session on quit failed:', error);
}

/**
 * @typedef {object} QuitSession  the HostingSession, or a fake
 * @property {() => Promise<void>} stop
 * @property {() => { status: HostingStatus }} getState
 */

/**
 * @typedef {object} QuitCleanupInput
 * @property {QuitSession} session
 * @property {QuitApp} app
 * @property {SignalTarget} [signalTarget]
 * @property {string[]} [signals]                    defaults to SIGINT, SIGTERM and SIGHUP
 * @property {(error: unknown) => void} [onError]    defaults to console.error
 * @property {() => Promise<boolean>} [confirmQuit]  asks "Stop hosting and quit?" and resolves
 *   true to quit; defaults to quitting without asking
 */

/** @typedef {Required<Pick<QuitCleanupInput, 'session' | 'app' | 'onError' | 'confirmQuit'>>} QuitCleanupParts */

async function confirmWithoutAsking() {
    return true;
}

/**
 * Whether the session has anything to stop. Failed is torn down already.
 * @param {QuitSession} session
 */
function isSessionActive(session) {
    const { status } = session.getState();
    return status !== 'idle' && status !== 'failed';
}

/**
 * Runs one quit at a time: ask (not for a signal), stop the session, then quit for real.
 * Phases: running -> asking -> stopping -> quitting -> running. Going back to running after
 * the re-issued quit means a quit that something else cancelled asks and stops again next time.
 */
class QuitCleanup {
    /** @type {'running' | 'asking' | 'stopping' | 'quitting'} */
    #phase = 'running';
    /** @type {QuitCleanupParts} */
    #parts;

    /** @param {QuitCleanupParts} parts */
    constructor(parts) {
        this.#parts = parts;
    }

    /** @param {{ preventDefault(): void }} event */
    handleBeforeQuit(event) {
        if (this.#phase === 'quitting') {
            return;
        }

        const isQuitPending = this.#phase === 'asking' || this.#phase === 'stopping';
        if (isQuitPending) {
            event.preventDefault();
            return;
        }
        if (!isSessionActive(this.#parts.session)) {
            return;
        }

        event.preventDefault();
        this.#askThenQuit();
    }

    // Nobody can answer a prompt for a signal, so it quits without asking, even mid-prompt.
    handleSignal() {
        this.#stopThenQuit();
    }

    async #askThenQuit() {
        this.#phase = 'asking';
        const confirmed = await this.#confirm();
        if (this.#phase !== 'asking') {
            // A signal took over while the prompt was open.
            return;
        }
        if (!confirmed) {
            this.#phase = 'running';
            return;
        }

        await this.#stopThenQuit();
    }

    /**
     * A prompt that fails counts as yes, so the user can always quit.
     * @returns {Promise<boolean>}
     */
    async #confirm() {
        try {
            return await this.#parts.confirmQuit();
        } catch (error) {
            this.#parts.onError(error);
            return true;
        }
    }

    async #stopThenQuit() {
        const isAlreadyStopping = this.#phase === 'stopping' || this.#phase === 'quitting';
        if (isAlreadyStopping) {
            return;
        }

        this.#phase = 'stopping';
        try {
            await this.#parts.session.stop();
        } catch (error) {
            this.#parts.onError(error);
        }

        // app.quit() emits 'before-quit' synchronously, so 'quitting' lets exactly that one through.
        this.#phase = 'quitting';
        try {
            this.#parts.app.quit();
        } finally {
            this.#phase = 'running';
        }
    }
}

/**
 * Makes every way out of the app stop hosting first, so cloudflared and the server never
 * outlive the launcher (decision 15). While the session is active, 'before-quit' is cancelled
 * and confirmQuit() asks "Stop hosting and quit?"; on yes the session is stopped and quit is
 * requested again, on no the app keeps hosting. Cmd+Q, the menu Quit and closing every window
 * all arrive as 'before-quit', so they share the one prompt; process signals stop and quit
 * without asking. A quit while idle or failed goes straight through.
 * @param {QuitCleanupInput} input
 * @returns {() => void} removes every listener it added
 */
export function installQuitCleanup({
    session,
    app,
    signalTarget,
    signals = DEFAULT_QUIT_SIGNALS,
    onError = logCleanupError,
    confirmQuit = confirmWithoutAsking,
}) {
    const cleanup = new QuitCleanup({ session, app, onError, confirmQuit });
    const handleBeforeQuit = (/** @type {{ preventDefault(): void }} */ event) => cleanup.handleBeforeQuit(event);
    const handleSignal = () => cleanup.handleSignal();
    const requestQuit = () => app.quit();

    app.on('before-quit', handleBeforeQuit);
    app.on('window-all-closed', requestQuit);
    for (const signal of signals) {
        signalTarget?.on(signal, handleSignal);
    }

    return () => {
        app.removeListener('before-quit', handleBeforeQuit);
        app.removeListener('window-all-closed', requestQuit);
        for (const signal of signals) {
            signalTarget?.removeListener(signal, handleSignal);
        }
    };
}
