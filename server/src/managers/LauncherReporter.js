// Sends room stats (roomStats.js) to the desktop launcher over Electron's utility-process parent
// port (X66). Changes are coalesced: the first one starts a REPORT_DELAY_MS wait, later ones ride
// on it, and the stats are sent only when they differ from the last ones sent. Without a parent
// port (Docker, `npm run dev`) every method does nothing.
import { LAUNCHER_MESSAGE } from '../../../shared/launcherMessages.js';
import { STATS_CHANGED } from './roomStats.js';

export const REPORT_DELAY_MS = 1000;

export class LauncherReporter {
    #parentPort;
    #buildStats;
    #delayMs;
    #logger;
    #statsEvents;
    #timer = null;
    #lastText = null;
    #isClosed = false;
    #onStatsChanged = () => this.markChanged();

    /**
     * @param {{ parentPort?: { postMessage(message: unknown): void } | null,
     *   buildStats: () => unknown, delayMs?: number,
     *   logger?: { error(...args: unknown[]): void },
     *   statsEvents?: import('node:events').EventEmitter | null }} options
     *   parentPort defaults to Electron's process.parentPort, which is undefined outside a utility
     *   process. `statsEvents` is the hub's: each STATS_CHANGED it emits marks the stats changed.
     */
    constructor({
        parentPort = /** @type {any} */ (process).parentPort ?? null,
        buildStats,
        delayMs = REPORT_DELAY_MS,
        logger = console,
        statsEvents = null,
    }) {
        this.#parentPort = parentPort;
        this.#buildStats = buildStats;
        this.#delayMs = delayMs;
        this.#logger = logger;
        // Without a parent port there is nobody to tell, so it doesn't listen at all.
        if (parentPort && statsEvents) {
            this.#statsEvents = statsEvents;
            statsEvents.on(STATS_CHANGED, this.#onStatsChanged);
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
        this.#statsEvents?.off(STATS_CHANGED, this.#onStatsChanged);
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
