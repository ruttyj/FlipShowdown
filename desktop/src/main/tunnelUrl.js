// Pure parsing of cloudflared's log output for a quick tunnel, ported from scripts/share.mjs.

// --- Patterns ------------------------------------------------------------------

// Matches the URL cloudflared prints in its banner, e.g.
// "|  https://calm-river-1234.trycloudflare.com  |" -> "https://calm-river-1234.trycloudflare.com".
// Skips "https://api.trycloudflare.com/tunnel", which cloudflared quotes in its error lines when
// it cannot request a tunnel, and rejects look-alikes such as "...trycloudflare.com.evil.example".
const TUNNEL_URL_PATTERN = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com(?![a-z0-9-]|\.[a-z0-9])/;

// Logged once the tunnel can carry traffic; before that the URL answers with errors.
const TUNNEL_READY_PATTERN = /Registered tunnel connection/;

// A partial line longer than this is not one cloudflared would print; only its tail is kept so
// a misbehaving process cannot grow the buffer without bound.
const MAX_PENDING_CHARS = 64 * 1024;

// --- Single-text checks --------------------------------------------------------

/**
 * The first trycloudflare URL in `text`, or null when it has not been printed yet.
 * @param {string} text
 * @returns {string | null}
 */
export function findTunnelUrl(text) {
    const match = text.match(TUNNEL_URL_PATTERN);
    if (!match) {
        return null;
    }
    return match[0];
}

/**
 * True once `text` contains the line saying a tunnel connection is registered.
 * @param {string} text
 * @returns {boolean}
 */
export function isTunnelReady(text) {
    return TUNNEL_READY_PATTERN.test(text);
}

// --- Streaming watcher ---------------------------------------------------------

/**
 * @typedef {object} TunnelLogState
 * @property {string | null} url  The tunnel's public URL, once printed. The first one wins.
 * @property {boolean} isReady    True once a tunnel connection has been registered.
 */

/**
 * Follows a cloudflared output stream chunk by chunk. Chunks can split a line anywhere, so only
 * complete lines are parsed; the unfinished tail waits for the next chunk.
 * @returns {{ push(chunk: string | Buffer): TunnelLogState }}
 */
export function createTunnelLogWatcher() {
    /** @type {TunnelLogState} */
    const state = { url: null, isReady: false };
    let pending = '';

    function push(chunk) {
        const lines = (pending + chunk.toString()).split(/\r?\n/);
        pending = keepTail(lines.pop() ?? '');

        for (const line of lines) {
            applyLine(state, line);
        }

        return { url: state.url, isReady: state.isReady };
    }

    return { push };
}

/**
 * @param {TunnelLogState} state
 * @param {string} line
 */
function applyLine(state, line) {
    if (state.url === null) {
        state.url = findTunnelUrl(line);
    }
    if (isTunnelReady(line)) {
        state.isReady = true;
    }
}

/** @param {string} text */
function keepTail(text) {
    if (text.length <= MAX_PENDING_CHARS) {
        return text;
    }
    return text.slice(-MAX_PENDING_CHARS);
}
