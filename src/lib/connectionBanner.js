// Decides what the connection banner shows. Kept pure so the timing rules are testable.

export const RECONNECT_DELAY_MS = 2000;

// --- Connection clock ----------------------------------------------------------

/** @typedef {import('../api/realtime.js').RealtimeStatus} RealtimeStatus */

/**
 * @typedef {object} ConnectionClock
 * @property {RealtimeStatus} status  the latest realtime status
 * @property {boolean} hasBeenLive whether a socket has ever been live this page load
 * @property {number|null} downSince  when the socket last left 'live' (ms), null while live
 *           or before the first live
 */

/**
 * @param {RealtimeStatus} status
 * @returns {ConnectionClock}
 */
export function createConnectionClock(status) {
    return { status, hasBeenLive: status === 'live', downSince: null };
}

/**
 * Records a status change. `downSince` is set once when leaving 'live' and kept through
 * reconnecting -> connecting -> reconnecting retries, so retries don't restart the delay.
 *
 * @param {ConnectionClock} clock
 * @param {RealtimeStatus} status
 * @param {number} now  ms timestamp
 * @returns {ConnectionClock} the same object when nothing changed
 */
export function advanceConnectionClock(clock, status, now) {
    if (status === 'live') {
        if (clock.status === 'live') {
            return clock;
        }
        return { status, hasBeenLive: true, downSince: null };
    }

    // Before the first live there is nothing to reconnect to, so no clock runs.
    let downSince = clock.downSince;
    if (clock.hasBeenLive && downSince === null) {
        downSince = now;
    }

    if (status === clock.status && downSince === clock.downSince) {
        return clock;
    }
    return { ...clock, status, downSince };
}

/** How long the socket has been down, for bannerState; 0 when it isn't. */
export function downForMs(clock, now) {
    if (clock.downSince === null) {
        return 0;
    }
    return now - clock.downSince;
}

/**
 * @param {RealtimeStatus} status realtime status
 * @param {number} sinceMs how long the socket has been down since it last left 'live'
 * @param {boolean} hasBeenLive whether a socket has ever been live this page load
 * @returns {'hidden'|'reconnecting'|'signed-out'}
 */
export function bannerState(status, sinceMs, hasBeenLive) {
    // A fresh load that is already signed out is handled by the page's own sign-in path
    // (Home's Sign in button, the room page redirect); the bar is only for losing the session mid-use.
    if (status === 'signed-out') {
        if (hasBeenLive) {
            return 'signed-out';
        }
        return 'hidden';
    }

    if (status === 'live') {
        return 'hidden';
    }

    // The first connect on page load is not a "re-"connect; stay quiet until a socket worked once.
    if (!hasBeenLive) {
        return 'hidden';
    }

    // Brief drops (a quick resync) would only flicker the banner.
    if (sinceMs < RECONNECT_DELAY_MS) {
        return 'hidden';
    }

    return 'reconnecting';
}
