// What the Home screen says about a hosting snapshot: the server and tunnel chips and the
// sentence read out to screen readers. Pure, so the wording for every status sits in one place.

/** @typedef {import('../shared/launcherBridge').HostingStatus} HostingStatus */
/** @typedef {import('../shared/launcherBridge').HostingSnapshot} HostingSnapshot */

/**
 * A chip's text and colour. off: nothing running; busy: on its way up or down; ok: working;
 * warn: working on a problem; error: stopped by a failure.
 * @typedef {{ label: string, tone: 'off' | 'busy' | 'ok' | 'warn' | 'error' }} ChipState
 */

/** @type {Record<HostingStatus, ChipState>} */
const SERVER_CHIPS = {
    'idle': { label: 'Stopped', tone: 'off' },
    'starting-server': { label: 'Starting', tone: 'busy' },
    'starting-tunnel': { label: 'Running', tone: 'ok' },
    'hosting': { label: 'Running', tone: 'ok' },
    'tunnel-restarting': { label: 'Running', tone: 'ok' },
    'stopping': { label: 'Stopping', tone: 'busy' },
    // A failure tears both children down; the error panel says which one failed.
    'failed': { label: 'Stopped', tone: 'error' },
};

/** @type {Record<Exclude<HostingStatus, 'tunnel-restarting'>, ChipState>} */
const TUNNEL_CHIPS = {
    'idle': { label: 'Off', tone: 'off' },
    'starting-server': { label: 'Waiting', tone: 'busy' },
    'starting-tunnel': { label: 'Connecting', tone: 'busy' },
    'hosting': { label: 'Connected', tone: 'ok' },
    'stopping': { label: 'Stopping', tone: 'busy' },
    'failed': { label: 'Stopped', tone: 'error' },
};

/**
 * @param {HostingStatus} status
 * @returns {ChipState}
 */
export function describeServer(status) {
    return SERVER_CHIPS[status];
}

/**
 * @param {HostingSnapshot} snapshot
 * @returns {ChipState}
 */
export function describeTunnel(snapshot) {
    if (snapshot.status !== 'tunnel-restarting') {
        return TUNNEL_CHIPS[snapshot.status];
    }

    if (snapshot.retry === null) {
        return { label: 'Reconnecting', tone: 'warn' };
    }
    const { attempt, maxRetries } = snapshot.retry;
    return { label: `Reconnecting (attempt ${attempt} of ${maxRetries})`, tone: 'warn' };
}

/**
 * Both chips as one sentence, e.g. "Server: Running. Tunnel: Connected."
 * @param {HostingSnapshot} snapshot
 */
export function describeHosting(snapshot) {
    return `Server: ${describeServer(snapshot.status).label}. Tunnel: ${describeTunnel(snapshot).label}.`;
}

/**
 * True while the session is starting or hosting, so the main button offers Stop.
 * @param {HostingStatus} status
 */
export function isSessionRunning(status) {
    return status === 'starting-server'
        || status === 'starting-tunnel'
        || status === 'hosting'
        || status === 'tunnel-restarting';
}

/**
 * True while the launcher keeps the computer from sleeping: hosting and while the tunnel
 * restarts, as in hostingSession.js (decision 6).
 * @param {HostingStatus} status
 */
export function isKeptAwake(status) {
    return status === 'hosting' || status === 'tunnel-restarting';
}

/**
 * How the live counts and the Rooms panel show for a status (X66). The counts appear once the
 * server is up (0 / 0 while the tunnel connects); both dim while the tunnel restarts, as phones
 * can't reach the server then and are about to drop off.
 * @param {HostingStatus} status
 * @returns {{ showsCounts: boolean, showsRooms: boolean, isStale: boolean }}
 */
export function describeLiveStats(status) {
    const isServerUp = status === 'starting-tunnel' || isKeptAwake(status);
    return {
        showsCounts: isServerUp,
        showsRooms: isKeptAwake(status),
        isStale: status === 'tunnel-restarting',
    };
}
