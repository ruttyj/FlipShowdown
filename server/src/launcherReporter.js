// Sends room stats (roomStats.js) to the desktop launcher over Electron's utility-process parent
// port (X66). Changes are coalesced: the first one starts a REPORT_DELAY_MS wait, later ones ride
// on it, and the stats are sent only when they differ from the last ones sent. Without a parent
// port (Docker, `npm run dev`) every method does nothing.
import { LAUNCHER_MESSAGE } from '../../shared/launcherMessages.js';

export const REPORT_DELAY_MS = 1000;

/**
 * @param {{ parentPort?: { postMessage(message: unknown): void } | null,
 *   buildStats: () => unknown, delayMs?: number,
 *   logger?: { error(...args: unknown[]): void } }} options
 *   parentPort defaults to Electron's process.parentPort, which is undefined outside a utility process
 * @returns {{ markChanged(): void, sendNow(): void, close(): void }}
 */
export function createLauncherReporter({
    parentPort = /** @type {any} */ (process).parentPort ?? null,
    buildStats,
    delayMs = REPORT_DELAY_MS,
    logger = console,
}) {
    if (!parentPort) {
        return { markChanged() {}, sendNow() {}, close() {} };
    }

    const reporter = { parentPort, buildStats, delayMs, logger, timer: null, lastText: null, isClosed: false };
    return {
        markChanged: () => scheduleReport(reporter),
        sendNow: () => report(reporter),
        close: () => {
            reporter.isClosed = true;
            clearTimeout(reporter.timer);
            reporter.timer = null;
        },
    };
}

/** Starts the delay unless one is already running. */
function scheduleReport(reporter) {
    if (reporter.timer || reporter.isClosed) {
        return;
    }
    reporter.timer = setTimeout(() => report(reporter), reporter.delayMs);
    reporter.timer.unref();
}

/** Builds and sends the stats when they changed. A failure is logged: stats are never worth a crash. */
function report(reporter) {
    clearTimeout(reporter.timer);
    reporter.timer = null;
    if (reporter.isClosed) {
        return;
    }

    try {
        const stats = reporter.buildStats();
        const text = JSON.stringify(stats);
        if (text === reporter.lastText) {
            return;
        }

        reporter.parentPort.postMessage({ type: LAUNCHER_MESSAGE.ROOM_STATS, stats });
        reporter.lastText = text;
    } catch (error) {
        reporter.logger.error('Reporting room stats to the launcher failed', error);
    }
}
