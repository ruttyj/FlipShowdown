// The realtime wire vocabulary, shared by the client (src/api/) and the server (server/src/). The
// message shapes and rules are in "Realtime" in docs/backend-contract.md. Changing a value here
// changes the wire format, and phones may still be running the old client.
//
// This folder sits beside src/ and server/, so anything that packages either must include it: the
// Dockerfile copies it into both stages. Its package.json marks it as ES modules, because the
// runtime image has no package.json above it.

export const REALTIME_PATH = '/api/realtime';

export const CLIENT_MESSAGE = Object.freeze({
    HELLO: 'hello',
    ROOMS: 'rooms',
    VOTE_HOLD: 'vote-hold',
    VOTE_RELEASE: 'vote-release',
    ENTRY_STATUS: 'entry-status',
    PING: 'ping',
});

export const SERVER_MESSAGE = Object.freeze({
    READY: 'ready',
    ROOMS_OK: 'rooms-ok',
    EVENT: 'event',
    RESYNC: 'resync',
    PONG: 'pong',
    PRESENCE: 'presence',
    ENTRY_STATUS: 'entry-status',
    VOTE: 'vote',
    VOTE_PASSED: 'vote-passed',
    VOTE_ERROR: 'vote-error',
});

// --- Timings the two sides have to agree on ---------------------------------------

// A client pings this often while visible, and the server counts a socket as live for the window
// after a ping, so a hidden or frozen page drops out of presence within the window.
export const PING_INTERVAL_MS = 10_000;
export const LIVE_WINDOW_MS = 15_000;

// A client repeats its entry status this often while entering, and the server drops a status this
// long after the last one. Scanning is long because a page suspended behind the camera can't send
// a heartbeat. Typing is short, so a crashed phone can't hold the banner for long, and has to
// survive a lost heartbeat.
export const ENTRY_STATUS_HEARTBEAT_MS = 15_000;
export const ENTRY_STATUS_TTL_MS = Object.freeze({
    scanning: 120_000,
    typing: 45_000,
});

// How long a vote has to be held. The server's timer decides; the client sizes its progress bar by it.
export const VOTE_HOLD_MS = 3000;
