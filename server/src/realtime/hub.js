import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { CLIENT_MESSAGE, REALTIME_PATH, SERVER_MESSAGE } from '../../../shared/realtimeProtocol.js';
import { Clock } from '../domain/clock.js';
import { ConnectionManager } from '../managers/ConnectionManager.js';
import { EntryStatusManager } from '../managers/EntryStatusManager.js';
import { EventPublisher } from '../managers/EventPublisher.js';
import { Lifecycle } from '../managers/Lifecycle.js';
import { PresenceManager } from '../managers/PresenceManager.js';
import { STATS_CHANGED } from '../managers/roomStats.js';
import { SubscriptionManager } from '../managers/SubscriptionManager.js';
import { VoteManager } from '../managers/VoteManager.js';

// The realtime hub: the WebSocket endpoint and the composition of the realtime managers.
// Sockets, liveness and timers are the ConnectionManager's; who listens to which room is the
// SubscriptionManager's; the event log, fan-out and replay are the EventPublisher's; who is online
// is the PresenceManager's; hold-to-vote is the VoteManager's and who is entering cards the
// EntryStatusManager's. The Lifecycle guards every callback and stops them all on close. The client
// message handlers below only route to the managers. `statsEvents` emits STATS_CHANGED whenever
// the launcher's room stats may have changed (X66).

const MAX_CLIENT_MESSAGE_BYTES = 16 * 1024;

// --- Upgrade handling ----------------------------------------------------

function getPathname(url) {
    try {
        return new URL(url, 'http://localhost').pathname;
    } catch {
        return null;
    }
}

/** Writes a minimal HTTP error response on a raw upgrade socket and closes it. */
function rejectUpgrade(socket, status, statusText, message) {
    const body = JSON.stringify({ message });
    socket.end(
        `HTTP/1.1 ${status} ${statusText}\r\n`
        + 'Content-Type: application/json\r\n'
        + `Content-Length: ${Buffer.byteLength(body)}\r\n`
        + 'Connection: close\r\n'
        + '\r\n'
        + body,
    );
}

/**
 * Logs and destroys a raw upgrade socket that errored (e.g. ECONNRESET when the
 * browser drops the connection during auth). Without a listener, Node treats
 * the 'error' as an uncaught exception and the whole process exits.
 */
function handleUpgradeSocketError(logger, socket, error) {
    logger.warn(`Realtime upgrade socket error: ${error.message}`);
    socket.destroy();
}

// --- Store reads -------------------------------------------------------------

/**
 * GameRoom and Player access shaped like RoomRepository's (get) and PlayerRepository's
 * (listByRoom, listByUserEmail, update). They go through the store facade at call time, not
 * store.repositories, because some tests wrap facade methods on a running server (see
 * docs/testing.md): entryStatus.test counts store.findRecords lookups.
 */
function createStoreViews(store) {
    return {
        rooms: {
            get: (roomId) => store.getRecord('GameRoom', roomId),
        },
        players: {
            listByRoom: (roomId) => store.findRecords('Player', 'room_id', roomId),
            listByUserEmail: (email) => store.findRecordsByEmail('Player', email),
            update: (playerId, changes) => store.updateRecord('Player', playerId, changes),
        },
    };
}

// --- Room state --------------------------------------------------------------

/**
 * Sends the per-room state a socket needs after ready / rooms-ok: presence, each topic's vote and,
 * when there is any, who is entering. Clients forget that list on ready / rooms-ok.
 */
function sendRoomStates(context, socket, roomIds) {
    for (const roomId of roomIds) {
        context.presence.sendState(socket, roomId);
        context.votes.sendStates(socket, roomId);
        context.entries.sendState(socket, roomId);
    }
}

/**
 * What follows a publish, once its events have gone out: the published rooms' entry status is
 * reconciled (so a client hears "Sam submitted" before the banner drops), and a GameRoom change
 * emits STATS_CHANGED, since a room's status, round and max score show in its launcher row (X66).
 * `published` is EventPublisher#publishAll's result.
 */
function afterPublish(context, published) {
    const roomIds = new Set(published.map((entry) => entry.roomId));
    context.entries.reconcileRooms(roomIds);

    if (published.some((entry) => entry.entity === 'GameRoom')) {
        context.statsEvents.emit(STATS_CHANGED);
    }
}

// --- Liveness and closing --------------------------------------------------

/** Records a client ping; a socket that had gone stale is live again, so its rooms update. */
function handlePing(context, socket) {
    if (context.connections.markHeard(socket)) {
        context.presence.refreshRooms(context.subscriptions.roomsOf(socket));
    }
    context.connections.send(socket, { type: SERVER_MESSAGE.PONG });
}

/** Marks sockets without a recent client ping as not live and updates their rooms. */
function checkLiveness(context) {
    const changedRooms = new Set();
    for (const socket of context.connections.updateLiveness()) {
        for (const roomId of context.subscriptions.roomsOf(socket)) {
            changedRooms.add(roomId);
        }
    }
    context.presence.refreshRooms(changedRooms);
}

function runPeriodicChecks(context) {
    checkLiveness(context);
    context.entries.sweepExpired();
}

function handleSocketClosed(context, socket) {
    const rooms = context.subscriptions.unsubscribeAll(socket);
    context.votes.dropAllHolds(socket);
    context.presence.refreshRooms(rooms);
}

// --- Hello / rooms -------------------------------------------------------

function handleHello(context, socket, message) {
    const subscription = context.subscriptions.resolve(socket.identity, message.rooms);
    const outcome = context.publisher.classifyHello(message.epoch, message.last_seq);
    // Everything from here to ready runs in one tick, so no live event can
    // slip between the replay and the socket receiving live events.
    const { removed, affected } = context.subscriptions.apply(socket, subscription);
    context.votes.dropHolds(socket, removed);

    if (outcome === 'resync') {
        context.connections.send(socket, { type: SERVER_MESSAGE.RESYNC });
    }
    if (outcome === 'replay') {
        context.publisher.replay(socket, message.last_seq);
    }

    const ready = { type: SERVER_MESSAGE.READY, epoch: context.publisher.epoch, seq: context.publisher.seq };
    context.connections.send(socket, ready);
    context.presence.refreshRooms(affected, { skipSocket: socket });
    sendRoomStates(context, socket, subscription.rooms);
}

function handleRooms(context, socket, message) {
    // A room list only makes sense once hello has set the socket's position.
    if (!context.subscriptions.isSubscribed(socket)) {
        return;
    }

    const subscription = context.subscriptions.resolve(socket.identity, message.rooms);
    const { added, removed, affected } = context.subscriptions.apply(socket, subscription);
    context.votes.dropHolds(socket, removed);

    context.connections.send(socket, { type: SERVER_MESSAGE.ROOMS_OK, seq: context.publisher.seq });
    context.presence.refreshRooms(affected, { skipSocket: socket });
    sendRoomStates(context, socket, added);
}

// --- Client messages -----------------------------------------------------

function handleClientMessage(context, socket, raw) {
    let message;
    try {
        message = JSON.parse(raw.toString());
    } catch {
        return;
    }

    if (message?.type === CLIENT_MESSAGE.HELLO) {
        handleHello(context, socket, message);
    } else if (message?.type === CLIENT_MESSAGE.ROOMS) {
        handleRooms(context, socket, message);
    } else if (message?.type === CLIENT_MESSAGE.VOTE_HOLD) {
        context.votes.hold(socket, message);
    } else if (message?.type === CLIENT_MESSAGE.VOTE_RELEASE) {
        context.votes.release(socket, message);
    } else if (message?.type === CLIENT_MESSAGE.ENTRY_STATUS) {
        context.entries.receive(socket, message);
    } else if (message?.type === CLIENT_MESSAGE.PING) {
        handlePing(context, socket);
    }
}

// --- Hub -----------------------------------------------------------------

function setUpSocket(context, socket) {
    context.subscriptions.register(socket);
    context.connections.register(socket, {
        onMessage: (raw) => handleClientMessage(context, socket, raw),
        onClose: () => handleSocketClosed(context, socket),
    });
}

/**
 * Builds the managers over one WebSocketServer, one Clock and one Lifecycle: the hub's context,
 * which the handlers above read.
 */
function createContext({
    store,
    isAdmin,
    logger,
    now,
    voteTopics,
    voteHoldMs,
    hostOfflineGraceMs,
    heartbeatIntervalMs,
    livenessCheckIntervalMs,
}) {
    const clock = new Clock(now);
    const statsEvents = new EventEmitter();
    const lifecycle = new Lifecycle({ logger });
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES });
    const { rooms, players } = createStoreViews(store);
    const connections = new ConnectionManager({
        clients: wss.clients,
        clock,
        lifecycle,
        logger,
        heartbeatIntervalMs,
        livenessCheckIntervalMs,
    });
    const subscriptions = new SubscriptionManager({ connections, players, isAdmin });
    const publisher = new EventPublisher({ eventLog: store.eventLog, connections, subscriptions, lifecycle });
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
        onRefreshed: (roomId, presencePlayers, options) => {
            votes.refreshRoom(roomId, presencePlayers, options);
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
        logger,
        voteTopics,
        holdMs: voteHoldMs,
        hostGraceMs: hostOfflineGraceMs,
    });
    const entries = new EntryStatusManager({ rooms, players, clock, connections, subscriptions, lifecycle });

    return {
        wss,
        lifecycle,
        connections,
        subscriptions,
        publisher,
        presence,
        votes,
        entries,
        statsEvents,
    };
}

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
 *   onStatsChanged() - optional listener for the hub's statsEvents
 *     STATS_CHANGED: presence or a GameRoom changed, so the launcher's room
 *     stats may have (X66). app.js hands statsEvents to the LauncherReporter.
 * The defaults live in the managers (votes.js, ConnectionManager.js); the hub
 * passes undefined through to them.
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
    onStatsChanged,
}) {
    const context = createContext({
        store,
        isAdmin,
        logger,
        now,
        voteTopics,
        voteHoldMs,
        hostOfflineGraceMs,
        heartbeatIntervalMs,
        livenessCheckIntervalMs,
    });
    if (onStatsChanged) {
        context.statsEvents.on(STATS_CHANGED, onStatsChanged);
    }

    context.wss.on('connection', (socket) => setUpSocket(context, socket));
    context.connections.startTimers(() => runPeriodicChecks(context));

    async function handleUpgrade(request, socket, head) {
        // Node drops its own HTTP error listener once a socket is handed to
        // 'upgrade', so attach one before any async work can let an error through.
        const onSocketError = (error) => handleUpgradeSocketError(logger, socket, error);
        socket.on('error', onSocketError);

        if (getPathname(request.url) !== REALTIME_PATH) {
            socket.destroy();
            return;
        }

        let identity = null;
        try {
            identity = await authenticate(request.headers);
        } catch (error) {
            logger.error('Realtime authentication failed', error);
        }
        if (!identity) {
            rejectUpgrade(socket, 401, 'Unauthorized', 'Authentication required');
            return;
        }

        // A socket that errored while auth was pending has already been destroyed.
        if (socket.destroyed) {
            return;
        }

        context.wss.handleUpgrade(request, socket, head, (webSocket) => {
            // The accepted WebSocket now owns the raw socket's errors (see ConnectionManager#register).
            socket.off('error', onSocketError);
            webSocket.identity = identity;
            context.wss.emit('connection', webSocket, request);
        });
    }

    return {
        get epoch() {
            return context.publisher.epoch;
        },

        get seq() {
            return context.publisher.seq;
        },

        /** An EventEmitter that emits STATS_CHANGED (roomStats.js) when the launcher's stats may have changed. */
        get statsEvents() {
            return context.statsEvents;
        },

        attach(server) {
            server.on('upgrade', (request, socket, head) => {
                handleUpgrade(request, socket, head).catch((error) => {
                    logger.error('Realtime upgrade failed', error);
                    socket.destroy();
                });
            });
        },

        /**
         * Stores entity changes in the event log and sends each to the sockets subscribed to its
         * room (EventPublisher#publishAll), then updates the published rooms' entry status and,
         * for a GameRoom change, emits STATS_CHANGED. `events` is [{ entity, type, record }]; `roomVersion` is the
         * room's version after the action that produced them (null for generic entity writes).
         * Throws only when storing fails, and then sends nothing.
         */
        publishAll(events, { roomVersion } = {}) {
            const published = context.publisher.publishAll(events, { roomVersion });
            afterPublish(context, published);
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
            for (const socket of context.subscriptions.dropNonMembers(roomId)) {
                // No broadcast needed: the forced refresh below sends every topic.
                context.votes.forgetHolds(socket, roomId);
            }
            context.presence.refresh(roomId, { force: true });
        },

        /**
         * Call after the room's host changed without a membership change (for
         * example make-host). A vote's voter minimum depends on whether the
         * host is online, so the room's votes are re-evaluated.
         */
        roomHostChanged(roomId) {
            context.votes.roomHostChanged(roomId);
        },

        /** The launcher's room stats (roomStats.js), for the launcher reporter. */
        buildRoomStats() {
            return context.presence.buildRoomStats();
        },

        /** Whether any of the room's players has a live socket subscribed to it right now. */
        hasPlayersOnline(roomId) {
            return context.presence.hasPlayersOnline(roomId);
        },

        /** Runs the periodic checks (liveness, expired entries) now (tests drive them with a fake clock). */
        checkLiveness() {
            runPeriodicChecks(context);
        },

        /** Stops every callback first, so the sockets terminated below close without effect. */
        close() {
            context.lifecycle.close();
            context.connections.close();
            context.votes.close();
            context.entries.close();
            context.wss.close();
        },
    };
}
