import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { LauncherReporter, REPORT_DELAY_MS } from '../../src/managers/LauncherReporter.js';
import { STATS_CHANGED } from '../../src/managers/roomStats.js';

// How the LauncherReporter hears about changes: it listens for the hub's STATS_CHANGED on
// `statsEvents`. launcherReporter.test covers the coalescing and sending; launcherStats.test the
// whole path through a running server.

describe('LauncherReporter statsEvents', () => {
    let statsEvents;
    let messages;
    let playersOnline;

    beforeEach(() => {
        mock.timers.enable({ apis: ['setTimeout'] });
        statsEvents = new EventEmitter();
        messages = [];
        playersOnline = 0;
    });

    afterEach(() => {
        mock.timers.reset();
    });

    function createReporter(parentPort = { postMessage: (message) => messages.push(message) }) {
        return new LauncherReporter({
            parentPort,
            buildStats: () => ({ playersOnline, roomsLive: 0, rooms: [] }),
            statsEvents,
        });
    }

    test('a STATS_CHANGED marks the stats changed, so they go out after the delay', () => {
        createReporter();

        playersOnline = 3;
        statsEvents.emit(STATS_CHANGED);
        assert.deepEqual(messages, []);

        mock.timers.tick(REPORT_DELAY_MS);
        assert.deepEqual(messages.map((message) => message.stats.playersOnline), [3]);
    });

    test('close stops listening', () => {
        const reporter = createReporter();

        reporter.close();

        assert.equal(statsEvents.listenerCount(STATS_CHANGED), 0);
    });

    test('without a parent port it does not listen at all', () => {
        createReporter(null);

        assert.equal(statsEvents.listenerCount(STATS_CHANGED), 0);
    });
});
