import { EventEmitter } from 'node:events';
import { Clock } from '../domain/clock.js';
import { ConnectionManager } from '../managers/ConnectionManager.js';
import { EntryStatusManager } from '../managers/EntryStatusManager.js';
import { EventPublisher } from '../managers/EventPublisher.js';
import { Lifecycle } from '../managers/Lifecycle.js';
import { PresenceManager } from '../managers/PresenceManager.js';
import { createStoreViews } from '../managers/storeViews.js';
import { SubscriptionManager } from '../managers/SubscriptionManager.js';
import { VoteManager } from '../managers/VoteManager.js';
import { createSocketHandlers } from './handlers/index.js';
import { createWebSocketServer, RealtimeServer } from './RealtimeServer.js';
import { RoomStateSnapshot } from './RoomStateSnapshot.js';
import { SocketHandlerRegistry } from './SocketHandlerRegistry.js';

// The realtime hub: the realtime managers, the socket edge (RealtimeServer and the client message
// handlers) and the hub object the rest of the server calls. Sockets, liveness and timers are the
// ConnectionManager's; who listens to which room is the SubscriptionManager's; the event log,
// fan-out and replay are the EventPublisher's; who is online is the PresenceManager's; hold-to-vote
// is the VoteManager's and who is entering cards the EntryStatusManager's. The Lifecycle guards
// every callback and stops them all on close. What crosses managers after a publish, a membership
// change or a liveness check is orchestrated here.

/** The hub's notification that the launcher's room stats may have changed (X66). */
const STATS_CHANGED = 'statsChanged';

// --- Building --------------------------------------------------------------

/** Builds the managers over one Clock and one Lifecycle. `settings` is createRealtimeHub's options. */
function createManagers(settings, webSocketServer, statsEvents) {
    const clock = new Clock(settings.now);
    const lifecycle = new Lifecycle({ logger: settings.logger });
    const { rooms, players } = createStoreViews(settings.store);
    const connections = new ConnectionManager({
        clients: webSocketServer.clients,
        clock,
        lifecycle,
        logger: settings.logger,
        heartbeatIntervalMs: settings.heartbeatIntervalMs,
        livenessCheckIntervalMs: settings.livenessCheckIntervalMs,
    });
    const subscriptions = new SubscriptionManager({ connections, players, isAdmin: settings.isAdmin });
    const publisher = new EventPublisher({ eventLog: settings.store.eventLog, connections, subscriptions, lifecycle });
    const presence = new PresenceManager({
        rooms,
        players,
        clock,
        connections,
        subscriptions,
        onStatsChanged: () => {
            statsEvents.emit(STATS_CHANGED);
        },
        // Every presence refresh ends in a vote refresh, since the voters are the online players.
        // `votes` is only built below, but no refresh can run before the hub is returned.
        onRefreshed: (roomId, presencePlayers, refreshOptions) => {
            votes.refreshRoom(roomId, presencePlayers, refreshOptions);
        },
    });
    const votes = new VoteManager({
        rooms,
        players,
        clock,
        connections,
        subscriptions,
        presence,
        lifecycle,
        logger: settings.logger,
        voteTopics: settings.voteTopics,
        holdMs: settings.voteHoldMs,
        hostGraceMs: settings.hostOfflineGraceMs,
    });
    const entries = new EntryStatusManager({ rooms, players, clock, connections, subscriptions, lifecycle });

    return { lifecycle, connections, subscriptions, publisher, presence, votes, entries };
}

/** The socket edge over the managers: the endpoint and its client message handlers. */
function createRealtimeServer(settings, webSocketServer, managers) {
    const roomStates = new RoomStateSnapshot(managers);
    const handlers = new SocketHandlerRegistry(createSocketHandlers({ ...managers, roomStates }));
    return new RealtimeServer({
        webSocketServer,
        authenticate: settings.authenticate,
        logger: settings.logger,
        connections: managers.connections,
        subscriptions: managers.subscriptions,
        presence: managers.presence,
        votes: managers.votes,
        handlers,
    });
}

// --- Cross-manager steps -----------------------------------------------------

/**
 * What follows a publish, once its events have gone out: the published rooms' entry status is
 * reconciled (so a client hears "Sam submitted" before the banner drops), and a GameRoom change
 * emits STATS_CHANGED, since a room's status, round and max score show in its launcher row (X66).
 * `published` is EventPublisher#publishAll's result.
 */
function afterPublish(managers, statsEvents, published) {
    const roomIds = new Set(published.map((entry) => entry.roomId));
    managers.entries.reconcileRooms(roomIds);

    if (published.some((entry) => entry.entity === 'GameRoom')) {
        statsEvents.emit(STATS_CHANGED);
    }
}

/** Marks sockets without a recent client ping as not live and updates their rooms. */
function checkLiveness(managers) {
    const changedRooms = new Set();
    for (const socket of managers.connections.updateLiveness()) {
        for (const roomId of managers.subscriptions.roomsOf(socket)) {
            changedRooms.add(roomId);
        }
    }
    managers.presence.refreshRooms(changedRooms);
}

/** The periodic check: liveness, then expired entry statuses. */
function runPeriodicChecks(managers) {
    checkLiveness(managers);
    managers.entries.sweepExpired();
}

// --- Hub -----------------------------------------------------------------

/**
 * Creates the realtime hub. Options:
 *   authenticate(headers) - resolves to { email, ... } or null; unauthenticated
 *     upgrades get a 401 and never reach ws
 *   store - the db.js store (event log, GameRoom and Player records)
 *   isAdmin(identity) - whether the identity may subscribe to "*"
 *   now - clock in ms for presence liveness and vote countdowns (tests;
 *     defaults to Date.now)
 *   voteTopics - hold-to-vote topic registry, topic -> { validateOption,
 *     resolve, hostDecides } (see actions/VoteTopics.js); none by default
 *   voteHoldMs - how long a vote must be held (tests; defaults to VOTE_HOLD_MS)
 *   hostOfflineGraceMs - how long the host must be offline before a vote can
 *     pass without them (defaults to HOST_OFFLINE_GRACE_MS)
 *   heartbeatIntervalMs, livenessCheckIntervalMs - the ConnectionManager's
 *     timers (tests; default to HEARTBEAT_INTERVAL_MS and
 *     LIVENESS_CHECK_INTERVAL_MS)
 * The defaults live in the managers (votes.js, ConnectionManager.js); the hub
 * passes undefined through to them.
 *
 * The returned object's methods can be replaced (tests do): the server reaches publishAll,
 * roomMembershipChanged and roomHostChanged through it at call time.
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
    const settings = {
        authenticate,
        store,
        isAdmin,
        logger,
        now,
        voteTopics,
        voteHoldMs,
        hostOfflineGraceMs,
        heartbeatIntervalMs,
        livenessCheckIntervalMs,
    };
    const statsEvents = new EventEmitter();
    const webSocketServer = createWebSocketServer();
    const managers = createManagers(settings, webSocketServer, statsEvents);
    const realtimeServer = createRealtimeServer(settings, webSocketServer, managers);
    managers.connections.startTimers(() => runPeriodicChecks(managers));
    // The lifecycle closes first, so the sockets terminated next close without effect.
    const closeOrder = [
        managers.lifecycle,
        managers.connections,
        managers.votes,
        managers.entries,
        realtimeServer,
    ];

    return {
        get epoch() {
            return managers.publisher.epoch;
        },

        get seq() {
            return managers.publisher.seq;
        },

        attach(server) {
            realtimeServer.attach(server);
        },

        /**
         * Stores entity changes in the event log and sends each to the sockets subscribed to its
         * room (EventPublisher#publishAll), then updates the published rooms' entry status and,
         * for a GameRoom change, emits STATS_CHANGED. `events` is [{ entity, type, record }];
         * `roomVersion` is the room's version after the action that produced them (null for
         * generic entity writes). Throws only when storing fails, and then sends nothing.
         */
        publishAll(events, { roomVersion } = {}) {
            const published = managers.publisher.publishAll(events, { roomVersion });
            afterPublish(managers, statsEvents, published);
        },

        /** publishAll for a single change. */
        publish(entity, type, record, options) {
            this.publishAll([{ entity, type, record }], options);
        },

        /**
         * Call after a Player joins, leaves or is kicked. Drops subscriptions of
         * sockets whose user is no longer a member (and their holds), then resends
         * the room's presence and votes; a pending vote is cancelled.
         */
        roomMembershipChanged(roomId) {
            for (const socket of managers.subscriptions.dropNonMembers(roomId)) {
                // No broadcast needed: the forced refresh below sends every topic.
                managers.votes.forgetHolds(socket, roomId);
            }
            managers.presence.refresh(roomId, { force: true });
        },

        /**
         * Call after the room's host changed without a membership change (for
         * example make-host). A vote's voter minimum depends on whether the
         * host is online, so the room's votes are re-evaluated.
         */
        roomHostChanged(roomId) {
            managers.votes.roomHostChanged(roomId);
        },

        /**
         * Calls `listener()` whenever the launcher's room stats may have changed: a room's presence
         * or a GameRoom changed (X66). Returns a function that stops it.
         */
        onStatsChanged(listener) {
            statsEvents.on(STATS_CHANGED, listener);
            return () => {
                statsEvents.off(STATS_CHANGED, listener);
            };
        },

        /** The launcher's room stats (roomStats.js), for the launcher reporter. */
        buildRoomStats() {
            return managers.presence.buildRoomStats();
        },

        /** Whether any of the room's players has a live socket subscribed to it right now. */
        hasPlayersOnline(roomId) {
            return managers.presence.hasPlayersOnline(roomId);
        },

        /** Runs the periodic checks (liveness, expired entries) now (tests drive them with a fake clock). */
        checkLiveness() {
            runPeriodicChecks(managers);
        },

        /** Stops every callback first, then the timers and sockets, then the endpoint. */
        close() {
            for (const part of closeOrder) {
                part.close();
            }
        },
    };
}
