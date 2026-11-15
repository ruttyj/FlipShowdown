import { EventEmitter } from 'node:events';
import { ConnectionManager } from '../managers/ConnectionManager.js';
import { EntryStatusManager } from '../managers/EntryStatusManager.js';
import { EventPublisher } from '../managers/EventPublisher.js';
import { Lifecycle } from '../managers/Lifecycle.js';
import { PresenceManager } from '../managers/PresenceManager.js';
import { SubscriptionManager } from '../managers/SubscriptionManager.js';
import { VoteManager } from '../managers/VoteManager.js';
import { createSocketHandlers } from './handlers/index.js';
import { createWebSocketServer, RealtimeServer } from './RealtimeServer.js';
import { RoomStateSnapshot } from './RoomStateSnapshot.js';
import { SocketHandlerRegistry } from './SocketHandlerRegistry.js';

// The realtime hub: the realtime managers, the socket edge (RealtimeServer and the client message
// handlers) and the object the rest of the server calls. Sockets, liveness and timers are the
// ConnectionManager's; who listens to which room is the SubscriptionManager's; the event log,
// fan-out and replay are the EventPublisher's; who is online is the PresenceManager's; hold-to-vote
// is the VoteManager's and who is entering cards the EntryStatusManager's. The Lifecycle guards
// every callback and stops them all on close. What crosses managers after a publish, a membership
// change, a presence refresh or a liveness check is orchestrated here.

/** The hub's notification that the launcher's room stats may have changed (X66). */
const STATS_CHANGED = 'statsChanged';

export class RealtimeHub {
    #statsEvents = new EventEmitter();
    #lifecycle;
    #connections;
    #subscriptions;
    #publisher;
    #presence;
    #votes;
    #entries;
    #realtimeServer;

    /**
     * Builds the managers and the socket edge and starts the connection timers. Options:
     *   authenticate(headers) - resolves to { email, ... } or null; unauthenticated upgrades get a
     *     401 and never reach ws
     *   eventLog - the EventRepository events are stored in and replayed from
     *   rooms, players - the GameRoom and Player reads and writes the managers use (see
     *     managers/storeViews.js for their shape)
     *   isAdmin(identity) - whether the identity may subscribe to "*"
     *   logger - console-like
     *   clock - the Clock every manager reads (presence liveness, vote countdowns, entry windows)
     *   voteTopics - hold-to-vote topic registry, topic -> { validateOption, resolve, hostDecides }
     *     (see actions/VoteTopics.js)
     *   voteHoldMs - how long a vote must be held
     *   hostOfflineGraceMs - how long the host must be offline before a vote can pass without them
     *   heartbeatIntervalMs, livenessCheckIntervalMs - the ConnectionManager's timers
     * The numbers may be undefined: the defaults live in the managers (votes.js,
     * ConnectionManager.js), and the hub passes undefined through to them.
     *
     * The instance's methods can be replaced (tests do): the server reaches publishAll,
     * roomMembershipChanged and roomHostChanged through the hub object at call time.
     */
    constructor(options) {
        const webSocketServer = createWebSocketServer();
        this.#createManagers(webSocketServer, options);
        this.#realtimeServer = this.#createRealtimeServer(webSocketServer, options);

        this.#connections.startTimers(() => this.#runPeriodicChecks());
    }

    get epoch() {
        return this.#publisher.epoch;
    }

    get seq() {
        return this.#publisher.seq;
    }

    /** Serves the realtime endpoint on `server`'s upgrade requests. */
    attach(server) {
        this.#realtimeServer.attach(server);
    }

    /**
     * Stores entity changes in the event log and sends each to the sockets subscribed to its room
     * (EventPublisher#publishAll), then updates the published rooms' entry status and, for a
     * GameRoom change, emits STATS_CHANGED. `events` is [{ entity, type, record }]; `roomVersion`
     * is the room's version after the action that produced them (null for generic entity writes).
     * Throws only when storing fails, and then sends nothing.
     */
    publishAll(events, { roomVersion } = {}) {
        const published = this.#publisher.publishAll(events, { roomVersion });
        this.#afterPublish(published);
    }

    /** publishAll for a single change. */
    publish(entity, type, record, options) {
        this.publishAll([{ entity, type, record }], options);
    }

    /**
     * Call after a Player joins, leaves or is kicked. Drops subscriptions of sockets whose user is
     * no longer a member (and their holds), then resends the room's presence and votes; a pending
     * vote is cancelled.
     */
    roomMembershipChanged(roomId) {
        for (const socket of this.#subscriptions.dropNonMembers(roomId)) {
            // No broadcast needed: the forced refresh below sends every topic.
            this.#votes.forgetHolds(socket, roomId);
        }
        this.#presence.refresh(roomId, { force: true });
    }

    /**
     * Call after the room's host changed without a membership change (for example make-host). A
     * vote's voter minimum depends on whether the host is online, so the room's votes are
     * re-evaluated.
     */
    roomHostChanged(roomId) {
        this.#votes.roomHostChanged(roomId);
    }

    /**
     * Calls `listener()` whenever the launcher's room stats may have changed: a room's presence or
     * a GameRoom changed (X66). Returns a function that stops it.
     */
    onStatsChanged(listener) {
        this.#statsEvents.on(STATS_CHANGED, listener);
        return () => {
            this.#statsEvents.off(STATS_CHANGED, listener);
        };
    }

    /** The launcher's room stats (roomStats.js), for the launcher reporter. */
    buildRoomStats() {
        return this.#presence.buildRoomStats();
    }

    /** Whether any of the room's players has a live socket subscribed to it right now. */
    hasPlayersOnline(roomId) {
        return this.#presence.hasPlayersOnline(roomId);
    }

    /** Runs the periodic checks (liveness, expired entries) now (tests drive them with a fake clock). */
    checkLiveness() {
        this.#runPeriodicChecks();
    }

    /** Stops every callback first, then the timers and sockets, then the endpoint. */
    close() {
        // The lifecycle closes first, so the sockets terminated next close without effect.
        const closeOrder = [
            this.#lifecycle,
            this.#connections,
            this.#votes,
            this.#entries,
            this.#realtimeServer,
        ];
        for (const part of closeOrder) {
            part.close();
        }
    }

    // --- Building ------------------------------------------------------------------

    /** Builds the managers over one Clock and one Lifecycle, from the constructor's options. */
    #createManagers(webSocketServer, {
        eventLog,
        rooms,
        players,
        isAdmin,
        logger,
        clock,
        voteTopics,
        voteHoldMs,
        hostOfflineGraceMs,
        heartbeatIntervalMs,
        livenessCheckIntervalMs,
    }) {
        this.#lifecycle = new Lifecycle({ logger });
        this.#connections = new ConnectionManager({
            clients: webSocketServer.clients,
            clock,
            lifecycle: this.#lifecycle,
            logger,
            heartbeatIntervalMs,
            livenessCheckIntervalMs,
        });
        this.#subscriptions = new SubscriptionManager({ connections: this.#connections, players, isAdmin });
        this.#publisher = new EventPublisher({
            eventLog,
            connections: this.#connections,
            subscriptions: this.#subscriptions,
            lifecycle: this.#lifecycle,
        });
        this.#presence = new PresenceManager({
            rooms,
            players,
            clock,
            connections: this.#connections,
            subscriptions: this.#subscriptions,
            onPresenceChanged: () => this.#presenceChanged(),
            onRefreshed: (roomId, presencePlayers, refreshOptions) => {
                this.#presenceRefreshed(roomId, presencePlayers, refreshOptions);
            },
        });
        this.#votes = new VoteManager({
            rooms,
            players,
            clock,
            connections: this.#connections,
            subscriptions: this.#subscriptions,
            presence: this.#presence,
            lifecycle: this.#lifecycle,
            logger,
            voteTopics,
            holdMs: voteHoldMs,
            hostGraceMs: hostOfflineGraceMs,
        });
        this.#entries = new EntryStatusManager({
            rooms,
            players,
            clock,
            connections: this.#connections,
            subscriptions: this.#subscriptions,
            lifecycle: this.#lifecycle,
        });
    }

    /** The socket edge over the managers: the endpoint and its client message handlers. */
    #createRealtimeServer(webSocketServer, { authenticate, logger }) {
        const managers = {
            lifecycle: this.#lifecycle,
            connections: this.#connections,
            subscriptions: this.#subscriptions,
            publisher: this.#publisher,
            presence: this.#presence,
            votes: this.#votes,
            entries: this.#entries,
        };
        const roomStates = new RoomStateSnapshot(managers);
        const handlers = new SocketHandlerRegistry(createSocketHandlers({ ...managers, roomStates }));
        return new RealtimeServer({
            webSocketServer,
            authenticate,
            logger,
            connections: this.#connections,
            subscriptions: this.#subscriptions,
            presence: this.#presence,
            votes: this.#votes,
            handlers,
        });
    }

    // --- Cross-manager steps -------------------------------------------------------

    /** A room's presence changed: who is online is what the launcher counts (X66). */
    #presenceChanged() {
        this.#statsEvents.emit(STATS_CHANGED);
    }

    /** Every presence refresh ends in a vote refresh, since the voters are the online players. */
    #presenceRefreshed(roomId, presencePlayers, refreshOptions) {
        this.#votes.refreshRoom(roomId, presencePlayers, refreshOptions);
    }

    /**
     * What follows a publish, once its events have gone out: the published rooms' entry status is
     * reconciled (so a client hears "Sam submitted" before the banner drops), and a GameRoom change
     * emits STATS_CHANGED, since a room's status, round and max score show in its launcher row
     * (X66). `published` is EventPublisher#publishAll's result.
     */
    #afterPublish(published) {
        const roomIds = new Set(published.map((entry) => entry.roomId));
        this.#entries.reconcileRooms(roomIds);

        if (published.some((entry) => entry.entity === 'GameRoom')) {
            this.#statsEvents.emit(STATS_CHANGED);
        }
    }

    /** Marks sockets without a recent client ping as not live and updates their rooms. */
    #updateLiveness() {
        const changedRooms = new Set();
        for (const socket of this.#connections.updateLiveness()) {
            for (const roomId of this.#subscriptions.roomsOf(socket)) {
                changedRooms.add(roomId);
            }
        }
        this.#presence.refreshRooms(changedRooms);
    }

    /** The periodic check: liveness, then expired entry statuses. */
    #runPeriodicChecks() {
        this.#updateLiveness();
        this.#entries.sweepExpired();
    }
}
