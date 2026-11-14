import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { LauncherReporter, REPORT_DELAY_MS } from '../../src/managers/LauncherReporter.js';

// How the LauncherReporter hears about changes: it subscribes through the hub's onStatsChanged,
// faked here. launcherReporter.test covers the coalescing and sending; launcherStats.test the
// whole path through a running server.

describe('LauncherReporter onStatsChanged', () => {
    let listeners;
    let messages;
    let playersOnline;

    beforeEach(() => {
        mock.timers.enable({ apis: ['setTimeout'] });
        listeners = new Set();
        messages = [];
        playersOnline = 0;
    });

    afterEach(() => {
        mock.timers.reset();
    });

    /** The hub's onStatsChanged over `listeners`. */
    function onStatsChanged(listener) {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }

    function statsChanged() {
        for (const listener of listeners) {
            listener();
        }
    }

    function createReporter(parentPort = { postMessage: (message) => messages.push(message) }) {
        return new LauncherReporter({
            parentPort,
            buildStats: () => ({ playersOnline, roomsLive: 0, rooms: [] }),
            onStatsChanged,
        });
    }

    test('a change marks the stats changed, so they go out after the delay', () => {
        createReporter();

        playersOnline = 3;
        statsChanged();
        assert.deepEqual(messages, []);

        mock.timers.tick(REPORT_DELAY_MS);
        assert.deepEqual(messages.map((message) => message.stats.playersOnline), [3]);
    });

    test('close stops listening', () => {
        const reporter = createReporter();

        reporter.close();

        assert.equal(listeners.size, 0);
    });

    test('without a parent port it does not listen at all', () => {
        createReporter(null);

        assert.equal(listeners.size, 0);
    });
});
