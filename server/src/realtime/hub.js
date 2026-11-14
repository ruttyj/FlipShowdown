import { Clock } from '../domain/clock.js';
import { RealtimeHub } from './RealtimeHub.js';

// Test-facing adapter: realtime.test, voteHub.test and hubStatsEvents.test build a hub standalone
// through createRealtimeHub. The server builds a RealtimeHub in providers/RealtimeProvider.js.

/**
 * Creates a RealtimeHub (see RealtimeHub.js for the options) with the old defaults: `isAdmin`
 * says no, `logger` is console, `voteTopics` is empty and `now` (a function returning ms,
 * Date.now by default) becomes the hub's Clock.
 */
export function createRealtimeHub({
    authenticate,
    store,
    isAdmin = () => false,
    logger = console,
    now = Date.now,
    voteTopics = {},
    voteHoldMs,
    hostOfflineGraceMs,
    heartbeatIntervalMs,
    livenessCheckIntervalMs,
}) {
    return new RealtimeHub({
        authenticate,
        store,
        isAdmin,
        logger,
        clock: new Clock(now),
        voteTopics,
        voteHoldMs,
        hostOfflineGraceMs,
        heartbeatIntervalMs,
        livenessCheckIntervalMs,
    });
}
