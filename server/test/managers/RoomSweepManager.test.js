import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { Clock } from '../../src/domain/clock.js';
import { RoomSweepManager, SWEEP_INTERVAL_MS } from '../../src/managers/RoomSweepManager.js';
import { createRecordingLogger } from './fakeSockets.js';

// RoomSweepManager over a fake room list, a fake presence and a fake runner. The rooms' last
// activity is in ms; the sweep's clock is set by hand and its interval runs on node:test's mock
// timers. staleRooms.test covers the sweep end to end through a running server.

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse('2030-01-02T00:00:00.000Z');
const MAX_IDLE_MS = 24 * HOUR_MS;
const DELETE_ACTION = { name: 'delete' };

describe('RoomSweepManager', () => {
    let rooms;
    let onlineRoomIds;
    let failingRoomIds;
    let deletions;
    let logger;

    beforeEach(() => {
        mock.timers.enable({ apis: ['setInterval'] });
        rooms = [
            { id: 'old', lastTouchedMs: NOW - 30 * HOUR_MS },
            { id: 'stale', lastTouchedMs: NOW - 25 * HOUR_MS },
            { id: 'fresh', lastTouchedMs: NOW - HOUR_MS },
        ];
        onlineRoomIds = new Set();
        failingRoomIds = new Map();
        deletions = [];
        logger = createRecordingLogger();
    });

    afterEach(() => {
        mock.timers.reset();
    });

    /** A RoomRepository stand-in: listIdle as the real one has it, over `rooms`. */
    function createFakeRooms() {
        return {
            listIdle: (cutoffMs) => rooms.filter((room) => room.lastTouchedMs < cutoffMs),
        };
    }

    /**
     * A RoomActionRunner stand-in that records each system run. A room in `failingRoomIds` answers
     * with the status it maps to, or throws when that is an Error.
     */
    function createFakeRunner() {
        return {
            runAsSystem(handler, roomId, body) {
                deletions.push({ handler, roomId, body });
                const failure = failingRoomIds.get(roomId);
                if (failure instanceof Error) {
                    throw failure;
                }
                return { status: failure ?? 200 };
            },
        };
    }

    function createSweeper(overrides = {}) {
        return new RoomSweepManager({
            rooms: createFakeRooms(),
            presence: { hasPlayersOnline: (roomId) => onlineRoomIds.has(roomId) },
            runner: createFakeRunner(),
            deleteAction: DELETE_ACTION,
            clock: new Clock(() => NOW),
            logger,
            maxIdleMs: MAX_IDLE_MS,
            ...overrides,
        });
    }

    describe('sweep', () => {
        test('deletes the idle rooms as the server, oldest first, and logs how many', () => {
            const deleted = createSweeper().sweep();

            assert.deepEqual(deleted, ['old', 'stale']);
            assert.deepEqual(deletions, [
                { handler: DELETE_ACTION, roomId: 'old', body: {} },
                { handler: DELETE_ACTION, roomId: 'stale', body: {} },
            ]);
            assert.deepEqual(logger.calls, [['log', 'Deleted 2 stale room(s)']]);
        });

        test('keeps an idle room while one of its players is online', () => {
            onlineRoomIds.add('old');

            assert.deepEqual(createSweeper().sweep(), ['stale']);
        });

        test('a room that fails to delete is logged and skipped, and the rest still go', () => {
            const error = new Error('broken room');
            failingRoomIds.set('old', error);

            const deleted = createSweeper().sweep();

            assert.deepEqual(deleted, ['stale']);
            assert.deepEqual(logger.calls, [
                ['error', 'Deleting stale room old failed', error],
                ['log', 'Deleted 1 stale room(s)'],
            ]);
        });

        test('a delete answered with another status does not count as deleted', () => {
            failingRoomIds.set('old', 409);
            failingRoomIds.set('stale', 409);

            assert.deepEqual(createSweeper().sweep(), []);
            assert.deepEqual(logger.calls, []);
        });

        test('does nothing when the sweep is off', () => {
            assert.deepEqual(createSweeper({ maxIdleMs: null }).sweep(), []);
            assert.deepEqual(deletions, []);
        });
    });

    describe('start and stop', () => {
        test('start sweeps now and then every interval until stopped', () => {
            const sweeper = createSweeper();

            sweeper.start();
            assert.equal(deletions.length, 2);

            mock.timers.tick(SWEEP_INTERVAL_MS);
            assert.equal(deletions.length, 4);

            sweeper.stop();
            mock.timers.tick(SWEEP_INTERVAL_MS);
            assert.equal(deletions.length, 4);
        });

        test('a second start does not start a second timer', () => {
            const sweeper = createSweeper({ intervalMs: 1000 });

            sweeper.start();
            sweeper.start();
            mock.timers.tick(1000);

            assert.equal(deletions.length, 4);
            sweeper.stop();
        });

        test('start does nothing when the sweep is off', () => {
            const sweeper = createSweeper({ maxIdleMs: null, intervalMs: 1000 });

            sweeper.start();
            mock.timers.tick(1000);

            assert.deepEqual(deletions, []);
        });

        test('a sweep that throws is logged and the next one still runs', () => {
            const error = new Error('database is locked');
            let listings = 0;
            const sweeper = createSweeper({
                intervalMs: 1000,
                rooms: {
                    listIdle: () => {
                        listings += 1;
                        throw error;
                    },
                },
            });

            sweeper.start();
            mock.timers.tick(1000);

            assert.equal(listings, 2);
            assert.deepEqual(logger.calls, [
                ['error', 'Stale room sweep failed', error],
                ['error', 'Stale room sweep failed', error],
            ]);
            sweeper.stop();
        });
    });
});
