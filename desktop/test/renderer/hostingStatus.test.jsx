import { describe, expect, test } from 'vitest';
import {
    describeHosting,
    describeLiveStats,
    describeServer,
    describeTunnel,
    isKeptAwake,
    isSessionRunning,
} from '../../src/renderer/hostingStatus.js';
import { makeSnapshot } from './fakeLauncher.jsx';

// --- Server chip ---------------------------------------------------------------------------

describe('describeServer', () => {
    test.each([
        ['idle', 'Stopped', 'off'],
        ['starting-server', 'Starting', 'busy'],
        ['starting-tunnel', 'Running', 'ok'],
        ['hosting', 'Running', 'ok'],
        ['tunnel-restarting', 'Running', 'ok'],
        ['stopping', 'Stopping', 'busy'],
        ['failed', 'Stopped', 'error'],
    ])('the server is %s -> "%s"', (status, label, tone) => {
        expect(describeServer(status)).toEqual({ label, tone });
    });
});

// --- Tunnel chip ---------------------------------------------------------------------------

describe('describeTunnel', () => {
    test.each([
        ['idle', 'Off', 'off'],
        ['starting-server', 'Waiting', 'busy'],
        ['starting-tunnel', 'Connecting', 'busy'],
        ['hosting', 'Connected', 'ok'],
        ['stopping', 'Stopping', 'busy'],
        ['failed', 'Stopped', 'error'],
    ])('the tunnel while %s -> "%s"', (status, label, tone) => {
        expect(describeTunnel(makeSnapshot({ status }))).toEqual({ label, tone });
    });

    test('a tunnel restart names the attempt it is waiting to make', () => {
        const snapshot = makeSnapshot({
            status: 'tunnel-restarting',
            retry: { attempt: 2, maxRetries: 3, delayMs: 2000 },
        });

        expect(describeTunnel(snapshot)).toEqual({ label: 'Reconnecting (attempt 2 of 3)', tone: 'warn' });
    });

    test('a tunnel restart without retry details just says reconnecting', () => {
        const snapshot = makeSnapshot({ status: 'tunnel-restarting', retry: null });

        expect(describeTunnel(snapshot)).toEqual({ label: 'Reconnecting', tone: 'warn' });
    });
});

// --- Summary -------------------------------------------------------------------------------

describe('describeHosting', () => {
    test('reads both chips as one sentence for screen readers', () => {
        expect(describeHosting(makeSnapshot({ status: 'hosting' }))).toBe('Server: Running. Tunnel: Connected.');
    });
});

describe('isSessionRunning', () => {
    test.each([
        ['idle', false],
        ['starting-server', true],
        ['starting-tunnel', true],
        ['hosting', true],
        ['tunnel-restarting', true],
        ['stopping', false],
        ['failed', false],
    ])('%s -> %s', (status, expected) => {
        expect(isSessionRunning(status)).toBe(expected);
    });
});

// --- Live stats (X66) ----------------------------------------------------------------------

describe('describeLiveStats and isKeptAwake', () => {
    test.each([
        // status, counts, rooms, stale, kept awake
        ['idle', false, false, false, false],
        ['starting-server', false, false, false, false],
        ['starting-tunnel', true, false, false, false],
        ['hosting', true, true, false, true],
        ['tunnel-restarting', true, true, true, true],
        ['stopping', false, false, false, false],
        ['failed', false, false, false, false],
    ])('%s', (status, showsCounts, showsRooms, isStale, isAwake) => {
        expect(describeLiveStats(status)).toEqual({ showsCounts, showsRooms, isStale });
        expect(isKeptAwake(status)).toBe(isAwake);
    });
});
