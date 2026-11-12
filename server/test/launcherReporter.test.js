import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { createLauncherReporter, REPORT_DELAY_MS } from '../src/launcherReporter.js';

// --- Builders --------------------------------------------------------------

function createFakePort() {
    const messages = [];
    return { messages, postMessage: (message) => messages.push(message) };
}

function makeStats(playersOnline = 0) {
    return { playersOnline, roomsLive: 0, rooms: [] };
}

/** A reporter on a fake port whose stats are whatever `current.stats` holds when it builds. */
function createReporter(options = {}) {
    const port = createFakePort();
    const current = { stats: makeStats(), builds: 0 };
    const reporter = createLauncherReporter({
        parentPort: port,
        buildStats: () => {
            current.builds += 1;
            return current.stats;
        },
        ...options,
    });
    return { port, current, reporter };
}

beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
});

afterEach(() => {
    mock.timers.reset();
});

// --- Coalescing --------------------------------------------------------------

describe('coalescing', () => {
    test('a burst of changes is built and sent once, a second after the first', () => {
        const { port, current, reporter } = createReporter();

        reporter.markChanged();
        current.stats = makeStats(5);
        mock.timers.tick(REPORT_DELAY_MS / 2);
        reporter.markChanged();
        reporter.markChanged();
        assert.equal(port.messages.length, 0);

        mock.timers.tick(REPORT_DELAY_MS / 2);

        assert.equal(current.builds, 1);
        assert.deepEqual(port.messages, [{ type: 'room-stats', stats: makeStats(5) }]);
    });

    test('stats that are the same as the last ones sent are not sent again', () => {
        const { port, current, reporter } = createReporter();

        reporter.sendNow();
        reporter.markChanged();
        mock.timers.tick(REPORT_DELAY_MS);

        assert.equal(current.builds, 2);
        assert.equal(port.messages.length, 1);
    });

    test('a change after a report starts a new wait', () => {
        const { port, current, reporter } = createReporter();

        reporter.markChanged();
        mock.timers.tick(REPORT_DELAY_MS);
        current.stats = makeStats(1);
        reporter.markChanged();
        mock.timers.tick(REPORT_DELAY_MS);

        assert.deepEqual(port.messages.map((message) => message.stats.playersOnline), [0, 1]);
    });

    test('sendNow sends straight away and cancels the pending wait', () => {
        const { port, current, reporter } = createReporter();

        reporter.markChanged();
        reporter.sendNow();
        mock.timers.tick(REPORT_DELAY_MS);

        assert.equal(current.builds, 1);
        assert.equal(port.messages.length, 1);
    });
});

// --- Closing and failures ---------------------------------------------------

describe('closing and failures', () => {
    test('close drops a pending report and ignores later changes', () => {
        const { port, reporter } = createReporter();

        reporter.markChanged();
        reporter.close();
        reporter.markChanged();
        reporter.sendNow();
        mock.timers.tick(REPORT_DELAY_MS);

        assert.equal(port.messages.length, 0);
    });

    test('a build that throws is logged, and the next change still reports', () => {
        const errors = [];
        const logger = { error: (...args) => errors.push(args) };
        let shouldThrow = true;
        const port = createFakePort();
        const reporter = createLauncherReporter({
            parentPort: port,
            logger,
            buildStats: () => {
                if (shouldThrow) {
                    throw new Error('database closed');
                }
                return makeStats(2);
            },
        });

        reporter.markChanged();
        mock.timers.tick(REPORT_DELAY_MS);
        shouldThrow = false;
        reporter.markChanged();
        mock.timers.tick(REPORT_DELAY_MS);

        assert.equal(errors.length, 1);
        assert.equal(port.messages.length, 1);
    });

    test('without a parent port (Docker, npm run dev) nothing is built or sent', () => {
        let builds = 0;
        const reporter = createLauncherReporter({ parentPort: null, buildStats: () => (builds += 1) });

        reporter.markChanged();
        reporter.sendNow();
        mock.timers.tick(REPORT_DELAY_MS);
        reporter.close();

        assert.equal(builds, 0);
    });

    test('outside Electron the default parent port is absent', () => {
        let builds = 0;
        const reporter = createLauncherReporter({ buildStats: () => (builds += 1) });

        reporter.sendNow();

        assert.equal(builds, 0);
    });
});
