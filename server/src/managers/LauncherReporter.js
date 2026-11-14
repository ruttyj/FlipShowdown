// Sends room stats (roomStats.js) to the desktop launcher over Electron's utility-process parent
// port (X66). Changes are coalesced: the first one starts a REPORT_DELAY_MS wait, later ones ride
// on it, and the stats are sent only when they differ from the last ones sent. Without a parent
// port (Docker, `npm run dev`) every method does nothing.
import { LAUNCHER_MESSAGE } from '../../../shared/launcherMessages.js';

export const REPORT_DELAY_MS = 1000;

export class LauncherReporter {
    #parentPort;
    #buildStats;
    #delayMs;
    #logger;
    #stopListening = null;
    #timer = null;
    #lastText = null;
    #isClosed = false;

    /**
     * @param {{ parentPort?: { postMessage(message: unknown): void } | null,
     *   buildStats: () => unknown, delayMs?: number,
     *   logger?: { error(...args: unknown[]): void },
     *   onStatsChanged?: ((listener: () => void) => () => void) | null }} options
     *   parentPort defaults to Electron's process.parentPort, which is undefined outside a utility
     *   process. `onStatsChanged(listener)` is the hub's: it calls the listener whenever the stats
     *   may have changed, which marks them changed, and returns a function that stops it. Without
     *   it the stats only go out on sendNow.
     */
    constructor({
        parentPort = /** @type {any} */ (process).parentPort ?? null,
        buildStats,
        delayMs = REPORT_DELAY_MS,
        logger = console,
        onStatsChanged = null,
    }) {
        this.#parentPort = parentPort;
        this.#buildStats = buildStats;
        this.#delayMs = delayMs;
        this.#logger = logger;
        // Without a parent port there is nobody to tell, so it doesn't listen at all.
        if (parentPort && onStatsChanged) {
            this.#stopListening = onStatsChanged(() => this.markChanged());
        }
    }

    /** The stats may have changed: starts the delay unless one is already running. */
    markChanged() {
        if (!this.#parentPort || this.#timer || this.#isClosed) {
            return;
        }
        this.#timer = setTimeout(() => this.#report(), this.#delayMs);
        this.#timer.unref();
    }

    /** Sends the stats now, if they changed (the server started listening). */
    sendNow() {
        if (!this.#parentPort) {
            return;
        }
        this.#report();
    }

    /** Stops listening and cancels a pending report; nothing is sent after this. */
    close() {
        this.#isClosed = true;
        clearTimeout(this.#timer);
        this.#timer = null;
        this.#stopListening?.();
        this.#stopListening = null;
    }

    /** Builds and sends the stats when they changed. A failure is logged: stats are never worth a crash. */
    #report() {
        clearTimeout(this.#timer);
        this.#timer = null;
        if (this.#isClosed) {
            return;
        }

        try {
            const stats = this.#buildStats();
            const text = JSON.stringify(stats);
            if (text === this.#lastText) {
                return;
            }

            this.#parentPort.postMessage({ type: LAUNCHER_MESSAGE.ROOM_STATS, stats });
            this.#lastText = text;
        } catch (error) {
            this.#logger.error('Reporting room stats to the launcher failed', error);
        }
    }
}

/**
 * The LauncherReporter, for launcherReporter.test. Same options; production code constructs the
 * class.
 *
 * @returns {{ markChanged(): void, sendNow(): void, close(): void }}
 */
export function createLauncherReporter(options) {
    return new LauncherReporter(options);
}
