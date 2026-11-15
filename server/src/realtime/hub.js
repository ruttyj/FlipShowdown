import { Clock } from '../domain/clock.js';
import { createStoreViews } from './storeViews.js';
import { RealtimeHub } from './RealtimeHub.js';

// Test-facing adapter: realtime.test, voteHub.test and hubStatsEvents.test build a hub standalone
// through createRealtimeHub, over a store. The server builds a RealtimeHub in
// providers/RealtimeProvider.js.

/**
 * Creates a RealtimeHub (see RealtimeHub.js for the options) over `store` (the db.js store: its
 * event log and the managers' GameRoom and Player views), with the old defaults: `isAdmin` says
 * no, `logger` is console, `voteTopics` is empty and `now` (a function returning ms, Date.now by
 * default) becomes the hub's Clock.
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
    const { rooms, players } = createStoreViews(store);
    return new RealtimeHub({
        authenticate,
        eventLog: store.repositories.events,
        rooms,
        players,
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
