// Pins the realtime wire vocabulary. Run with `npm test`. These values are the wire format, so a
// failure here means a client and server of different ages would stop understanding each other.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CLIENT_MESSAGE,
    ENTRY_STATUS_HEARTBEAT_MS,
    ENTRY_STATUS_TTL_MS,
    LIVE_WINDOW_MS,
    PING_INTERVAL_MS,
    REALTIME_PATH,
    SERVER_MESSAGE,
} from '../shared/realtimeProtocol.js';

test('the message types a client sends are fixed', () => {
    assert.deepEqual(
        Object.values(CLIENT_MESSAGE).sort(),
        ['entry-status', 'hello', 'ping', 'rooms', 'vote-hold', 'vote-release'],
    );
});

test('the message types a server sends are fixed', () => {
    assert.deepEqual(
        Object.values(SERVER_MESSAGE).sort(),
        ['entry-status', 'event', 'pong', 'presence', 'ready', 'resync', 'rooms-ok', 'vote', 'vote-error', 'vote-passed'],
    );
});

test('the socket path is fixed', () => {
    assert.equal(REALTIME_PATH, '/api/realtime');
});

test('a socket that pings on time stays live', () => {
    assert.ok(PING_INTERVAL_MS < LIVE_WINDOW_MS);
});

test('an entry status survives one lost heartbeat in either state', () => {
    for (const ttl of Object.values(ENTRY_STATUS_TTL_MS)) {
        assert.ok(ENTRY_STATUS_HEARTBEAT_MS * 2 < ttl);
    }
});
