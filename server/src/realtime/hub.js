import { WebSocketServer } from 'ws';
import {
    CLIENT_MESSAGE,
    REALTIME_PATH,
    SERVER_MESSAGE,
    VOTE_HOLD_MS,
} from '../../../shared/realtimeProtocol.js';
import { Clock } from '../domain/clock.js';
import { isHostPlayer } from '../domain/players.js';
import {
    ConnectionManager,
    HEARTBEAT_INTERVAL_MS,
    LIVENESS_CHECK_INTERVAL_MS,
} from '../managers/ConnectionManager.js';
import { createEntryStatusTracker, isEntryState } from '../managers/entryStatus.js';
import { EventPublisher } from '../managers/EventPublisher.js';
import { buildRoomStats } from '../managers/roomStats.js';
import { SubscriptionManager } from '../managers/SubscriptionManager.js';
import { createVoteTracker, HOST_OFFLINE_GRACE_MS } from '../managers/votes.js';

// The realtime hub: the WebSocket endpoint and the composition of the realtime managers.
// Sockets, liveness and timers are the ConnectionManager's; who listens to which room is the
// SubscriptionManager's; the event log, fan-out and replay are the EventPublisher's. Presence,
// votes and entry status are still here.

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

// --- Player reads ----------------------------------------------------------

/**
 * Player reads shaped like PlayerRepository's (listByRoom, listByUserEmail). They go through the
 * store facade at call time, not store.repositories.players, because entryStatus.test counts
 * database lookups by wrapping store.findRecords.
 */
function createPlayerReader(store) {
    return {
        listByRoom: (roomId) => store.findRecords('Player', 'room_id', roomId),
        listByUserEmail: (email) => store.findRecordsByEmail('Player', email),
    };
}

// --- Presence ------------------------------------------------------------

/**
 * Emails with a live socket explicitly subscribed to the room. Admin "*"
 * sockets are watching, not playing, so they don't make anyone online.
 */
function onlineEmails(context, roomId) {
    const emails = new Set();
    for (const socket of context.wss.clients) {
        if (socket.isSubscribed && socket.isLive && socket.rooms.has(roomId)) {
            emails.add(socket.identity.email);
        }
    }
    return emails;
}

function buildPresencePlayers(context, roomId) {
    const online = onlineEmails(context, roomId);
    const players = [];
    for (const player of context.players.listByRoom(roomId)) {
        players.push({
            player_id: player.id,
            online: online.has(player.email),
            last_seen: player.last_seen ?? null,
        });
    }
    return players;
}

/**
 * Writes Player.last_seen for players who were online and now aren't, and
 * puts the new value in `players`. No entity event is published for it; the
 * presence message carries it.
 */
function recordWentOffline(context, previousPlayers, players) {
    const wasOnline = new Set();
    for (const player of previousPlayers) {
        if (player.online) {
            wasOnline.add(player.player_id);
        }
    }

    const timestamp = new Date(context.clock.now()).toISOString();
    for (const player of players) {
        if (!player.online && wasOnline.has(player.player_id)) {
            context.store.updateRecord('Player', player.player_id, { last_seen: timestamp });
            player.last_seen = timestamp;
        }
    }
}

// --- Hold-to-vote state ----------------------------------------------------

function buildVoteMessage(context, roomId, topic) {
    return { type: SERVER_MESSAGE.VOTE, room_id: roomId, topic, ...context.votes.snapshot(roomId, topic) };
}

/** Sends the `vote` state for each changed { roomId, topic } to its room. */
function broadcastVoteChanges(context, changes, skipSocket = null) {
    for (const { roomId, topic } of changes) {
        context.subscriptions.sendToRoom(roomId, buildVoteMessage(context, roomId, topic), skipSocket);
    }
}

/** The room's host Player id, or null when the room or its host is gone. */
function hostPlayerIdOf(room, players) {
    if (!room) {
        return null;
    }
    const host = players.find((player) => isHostPlayer(room, player));
    return host?.id ?? null;
}

/** When the offline host was last seen, in ms; null when the host is online or never seen. */
function hostOfflineSinceOf(presencePlayers, hostPlayerId) {
    const host = presencePlayers.find((player) => player.player_id === hostPlayerId);
    if (!host || host.online || !host.last_seen) {
        return null;
    }
    return Date.parse(host.last_seen);
}

/**
 * Feeds the room's online players and host to the vote tracker, and
 * broadcasts the topics that changed. `presencePlayers` is the presence
 * message's player list. `force` is for joins, leaves and kicks, which cancel
 * a pending vote even when the online players stay the same.
 */
function refreshVotes(context, roomId, presencePlayers, { force = false, skipSocket = null } = {}) {
    if (!context.subscriptions.hasSubscribers(roomId)) {
        context.votes.forgetRoom(roomId);
        return;
    }

    const onlinePlayerIds = [];
    for (const player of presencePlayers) {
        if (player.online) {
            onlinePlayerIds.push(player.player_id);
        }
    }
    const room = context.store.getRecord('GameRoom', roomId);
    const hostPlayerId = hostPlayerIdOf(room, context.players.listByRoom(roomId));
    const hostOfflineSince = hostOfflineSinceOf(presencePlayers, hostPlayerId);

    const electorate = { onlinePlayerIds, hostPlayerId, hostOfflineSince };
    const changes = context.votes.setElectorate(roomId, electorate, { force });
    broadcastVoteChanges(context, changes, skipSocket);
}

// --- Presence refresh ------------------------------------------------------

/**
 * Recomputes a room's presence and sends it to the room's sockets when it
 * changed (or always, with `force`), then updates the room's votes.
 * `skipSocket` is left out because the caller sends it the state itself, in
 * the right order after ready / rooms-ok.
 */
function refreshPresence(context, roomId, { force = false, skipSocket = null } = {}) {
    const previous = context.presence.get(roomId);
    const players = buildPresencePlayers(context, roomId);
    recordWentOffline(context, previous?.players ?? [], players);

    const text = JSON.stringify({ type: SERVER_MESSAGE.PRESENCE, room_id: roomId, players });
    const hasChanged = text !== previous?.text;

    // Nobody is watching the room any more, so there is no transition to track.
    if (context.subscriptions.hasSubscribers(roomId)) {
        context.presence.set(roomId, { players, text });
    } else {
        context.presence.delete(roomId);
    }

    if (hasChanged || force) {
        for (const socket of context.wss.clients) {
            if (socket !== skipSocket && context.subscriptions.isSubscribedToRoom(socket, roomId)) {
                context.connections.send(socket, text);
            }
        }
        // Who is online is what the launcher counts (X66).
        context.onStatsChanged();
    }
    refreshVotes(context, roomId, players, { force, skipSocket });
}

function refreshRooms(context, roomIds, options) {
    for (const roomId of roomIds) {
        refreshPresence(context, roomId, options);
    }
}

// --- Entering-cards status ------------------------------------------------

function buildEntryStatusMessage(context, roomId) {
    return { type: SERVER_MESSAGE.ENTRY_STATUS, room_id: roomId, entries: context.entries.list(roomId) };
}

function broadcastEntryStatus(context, roomId) {
    context.subscriptions.sendToRoom(roomId, buildEntryStatusMessage(context, roomId));
}

/**
 * Whether this player can be entering cards for `round`: the round is open, and they haven't
 * scored it yet, which also stops a heartbeat that crossed their submit from bringing them back.
 */
function canEnterCards(room, player, round) {
    if (!room || !player) {
        return false;
    }
    return room.status === 'playing'
        && room.current_round === round
        && player.has_submitted_round !== true;
}

/**
 * Drops the entries the room's latest state rules out. This one check covers a submit, a leave or
 * kick, a status change and the round moving on, whichever action caused them.
 */
function reconcileEntries(context, roomId) {
    if (!context.entries.hasEntries(roomId)) {
        return;
    }

    const room = context.store.getRecord('GameRoom', roomId);
    const players = context.players.listByRoom(roomId);
    const hasChanged = context.entries.retain(roomId, (entry) => {
        const player = players.find((candidate) => candidate.id === entry.player_id);
        return canEnterCards(room, player, entry.round);
    });
    if (hasChanged) {
        broadcastEntryStatus(context, roomId);
    }
}

function sweepExpiredEntries(context) {
    for (const roomId of context.entries.sweepExpired()) {
        broadcastEntryStatus(context, roomId);
    }
}

/**
 * Sends the per-room state a socket needs after ready / rooms-ok: presence, each topic's vote and,
 * when there is any, who is entering. Clients forget that list on ready / rooms-ok.
 */
function sendRoomStates(context, socket, roomIds) {
    for (const roomId of roomIds) {
        const presence = context.presence.get(roomId);
        if (presence) {
            context.connections.send(socket, presence.text);
        }
        for (const topic of Object.keys(context.voteTopics)) {
            context.connections.send(socket, buildVoteMessage(context, roomId, topic));
        }
        const entryStatus = buildEntryStatusMessage(context, roomId);
        if (entryStatus.entries.length > 0) {
            context.connections.send(socket, entryStatus);
        }
    }
}

// --- Publishing ------------------------------------------------------------

/**
 * What follows a publish, once its events have gone out: the published rooms' entry status is
 * reconciled (so a client hears "Sam submitted" before the banner drops), and a GameRoom change
 * marks the launcher's stats as changed, since a room's status, round and max score show in its
 * row (X66). `published` is EventPublisher#publishAll's result.
 */
function afterPublish(context, published) {
    const roomIds = new Set(published.map((entry) => entry.roomId));
    for (const roomId of roomIds) {
        context.connections.runGuarded('entry status', () => reconcileEntries(context, roomId));
    }

    if (published.some((entry) => entry.entity === 'GameRoom')) {
        context.onStatsChanged();
    }
}

// --- Liveness and closing --------------------------------------------------

/** Records a client ping; a socket that had gone stale is live again, so its rooms update. */
function handlePing(context, socket) {
    if (context.connections.markHeard(socket)) {
        refreshRooms(context, socket.rooms);
    }
    context.connections.send(socket, { type: SERVER_MESSAGE.PONG });
}

/** Marks sockets without a recent client ping as not live and updates their rooms. */
function checkLiveness(context) {
    const changedRooms = new Set();
    for (const socket of context.connections.updateLiveness()) {
        for (const roomId of socket.rooms) {
            changedRooms.add(roomId);
        }
    }
    refreshRooms(context, changedRooms);
}

function runPeriodicChecks(context) {
    checkLiveness(context);
    sweepExpiredEntries(context);
}

/** A socket that unsubscribed from rooms lets go of its holds there. */
function dropHoldsInRooms(context, socket, roomIds) {
    if (roomIds.length === 0) {
        return;
    }
    broadcastVoteChanges(context, context.votes.dropSocket(socket, roomIds));
}

function handleSocketClosed(context, socket) {
    const rooms = context.subscriptions.unsubscribeAll(socket);
    broadcastVoteChanges(context, context.votes.dropSocket(socket));
    refreshRooms(context, rooms);
}

// --- Hello / rooms -------------------------------------------------------

function handleHello(context, socket, message) {
    const subscription = context.subscriptions.resolve(socket.identity, message.rooms);
    const outcome = context.publisher.classifyHello(message.epoch, message.last_seq);
    // Everything from here to ready runs in one tick, so no live event can
    // slip between the replay and the socket receiving live events.
    const { removed, affected } = context.subscriptions.apply(socket, subscription);
    dropHoldsInRooms(context, socket, removed);

    if (outcome === 'resync') {
        context.connections.send(socket, { type: SERVER_MESSAGE.RESYNC });
    }
    if (outcome === 'replay') {
        context.publisher.replay(socket, message.last_seq);
    }

    const ready = { type: SERVER_MESSAGE.READY, epoch: context.publisher.epoch, seq: context.publisher.seq };
    context.connections.send(socket, ready);
    refreshRooms(context, affected, { skipSocket: socket });
    sendRoomStates(context, socket, subscription.rooms);
}

function handleRooms(context, socket, message) {
    // A room list only makes sense once hello has set the socket's position.
    if (!socket.isSubscribed) {
        return;
    }

    const subscription = context.subscriptions.resolve(socket.identity, message.rooms);
    const { added, removed, affected } = context.subscriptions.apply(socket, subscription);
    dropHoldsInRooms(context, socket, removed);

    context.connections.send(socket, { type: SERVER_MESSAGE.ROOMS_OK, seq: context.publisher.seq });
    refreshRooms(context, affected, { skipSocket: socket });
    sendRoomStates(context, socket, added);
}

// --- Vote messages -------------------------------------------------------

function sendVoteError(context, socket, message, code) {
    context.connections.send(socket, {
        type: SERVER_MESSAGE.VOTE_ERROR,
        room_id: message.room_id ?? null,
        topic: message.topic ?? null,
        code,
    });
}

/**
 * Checks a vote-hold / vote-release and finds the sender's Player. Returns
 * { roomId, topic, player }, or null after replying with a vote-error.
 */
function resolveVoter(context, socket, message) {
    const { room_id: roomId, topic } = message;
    const hasFields = typeof roomId === 'string' && typeof topic === 'string';
    if (!hasFields) {
        sendVoteError(context, socket, message, 'bad_request');
        return null;
    }
    if (!Object.hasOwn(context.voteTopics, topic)) {
        sendVoteError(context, socket, message, 'unknown_topic');
        return null;
    }

    const player = context.subscriptions.findSubscribedPlayer(socket, roomId);
    if (!player) {
        sendVoteError(context, socket, message, 'not_member');
        return null;
    }
    return { roomId, topic, player };
}

function handleVoteHold(context, socket, message) {
    const voter = resolveVoter(context, socket, message);
    if (!voter) {
        return;
    }

    const room = context.store.getRecord('GameRoom', voter.roomId);
    const players = context.players.listByRoom(voter.roomId);
    const isValid = typeof message.option === 'string'
        && context.voteTopics[voter.topic].validateOption(room, players, message.option);
    if (!isValid) {
        sendVoteError(context, socket, message, 'invalid_option');
        return;
    }

    const changes = context.votes.hold(voter.roomId, voter.topic, {
        socketId: socket,
        playerId: voter.player.id,
        option: message.option,
    });
    broadcastVoteChanges(context, changes);
}

function handleVoteRelease(context, socket, message) {
    const voter = resolveVoter(context, socket, message);
    if (!voter) {
        return;
    }
    broadcastVoteChanges(context, context.votes.release(voter.roomId, voter.topic, socket));
}

/**
 * The tracker's timer fired: everyone held `option` for the whole hold time,
 * and the topic's holds are already cleared. Re-checks the option against the
 * room as it is now (it may have closed meanwhile), sends the cleared vote
 * state, then runs the topic's action. vote-passed goes out only once the
 * action succeeded, after its entity events. A host change re-evaluates the
 * votes through the action's publishing (see roomHostChanged).
 */
function handleVotePassed(context, roomId, topic, option) {
    const definition = context.voteTopics[topic];
    const room = context.store.getRecord('GameRoom', roomId);
    const isStillValid = definition.validateOption(room, context.players.listByRoom(roomId), option);

    broadcastVoteChanges(context, [{ roomId, topic }]);
    if (!isStillValid) {
        return;
    }

    const result = definition.resolve(roomId, option);
    if (result.status !== 200) {
        context.logger.warn(`Vote ${topic} in room ${roomId} failed: ${result.body.code}`);
        return;
    }
    const passed = { type: SERVER_MESSAGE.VOTE_PASSED, room_id: roomId, topic, option };
    context.subscriptions.sendToRoom(roomId, passed);
}

// --- Entry status messages -------------------------------------------------

/**
 * A player saying they are scanning, typing or (null) done. It is only advisory, so anything
 * invalid is ignored without a reply. Stopping always counts, even for a round that has ended.
 * The checks before the player lookup are memory-only, so a flood of these costs next to nothing.
 */
function handleEntryStatus(context, socket, message) {
    const { room_id: roomId, state, round } = message;
    const hasFields = typeof roomId === 'string'
        && Number.isInteger(round)
        && (state === null || isEntryState(state));
    if (!hasFields || !context.subscriptions.isExplicitlySubscribed(socket, roomId)) {
        return;
    }

    const who = socket.identity.email;
    let isAdmitted;
    if (state === null) {
        isAdmitted = context.entries.admitClear(roomId, who);
    } else {
        // A state held past the window goes through the same checks then, so a submit, a kick or a
        // socket that has left the room since all stop it.
        const applyHeld = () => {
            context.connections.runGuarded('held entry status', () => applyEntryStatus(context, socket, message));
        };
        isAdmitted = context.entries.admitAnnounce(roomId, who, { state, round }, applyHeld);
    }
    if (isAdmitted) {
        applyEntryStatus(context, socket, message);
    }
}

/** Puts a checked and admitted status into effect, and tells the room if that changed anything. */
function applyEntryStatus(context, socket, { room_id: roomId, state, round }) {
    const player = context.subscriptions.findSubscribedPlayer(socket, roomId);
    if (!player) {
        return;
    }

    let hasChanged = false;
    if (state === null) {
        hasChanged = context.entries.clear(roomId, player.id);
    } else if (canEnterCards(context.store.getRecord('GameRoom', roomId), player, round)) {
        hasChanged = context.entries.set(roomId, player.id, { state, round });
    }

    if (hasChanged) {
        broadcastEntryStatus(context, roomId);
    }
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
        handleVoteHold(context, socket, message);
    } else if (message?.type === CLIENT_MESSAGE.VOTE_RELEASE) {
        handleVoteRelease(context, socket, message);
    } else if (message?.type === CLIENT_MESSAGE.ENTRY_STATUS) {
        handleEntryStatus(context, socket, message);
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
 * Builds the managers over one WebSocketServer and one Clock, and the hub's context: what the
 * presence, vote and entry status code above reads. The vote and entry trackers are added by
 * createRealtimeHub, since their callbacks need the context.
 */
function createContext({
    store,
    isAdmin,
    logger,
    now,
    voteTopics,
    heartbeatIntervalMs,
    livenessCheckIntervalMs,
    onStatsChanged,
}) {
    const clock = new Clock(now);
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES });
    const players = createPlayerReader(store);
    const connections = new ConnectionManager({
        clients: wss.clients,
        clock,
        logger,
        heartbeatIntervalMs,
        livenessCheckIntervalMs,
    });
    const subscriptions = new SubscriptionManager({ connections, players, isAdmin });
    const publisher = new EventPublisher({ eventLog: store.eventLog, connections, subscriptions });

    return {
        store,
        players,
        logger,
        clock,
        wss,
        connections,
        subscriptions,
        publisher,
        // roomId -> { players, text } as last sent, to detect changes.
        presence: new Map(),
        voteTopics,
        votes: null,
        entries: createEntryStatusTracker({ now: () => clock.now() }),
        onStatsChanged,
    };
}

/**
 * Creates the realtime hub. Options:
 *   authenticate(headers) - resolves to { email, ... } or null; unauthenticated
 *     upgrades get a 401 and never reach ws
 *   store - the db.js store (event log, Player records)
 *   isAdmin(identity) - whether the identity may subscribe to "*"
 *   now - clock in ms for presence liveness and vote countdowns (tests;
 *     defaults to Date.now)
 *   voteTopics - hold-to-vote topic registry, topic -> { validateOption,
 *     resolve, hostDecides } (see actions/VoteTopics.js); none by default
 *   voteHoldMs - how long a vote must be held (tests; defaults to VOTE_HOLD_MS)
 *   hostOfflineGraceMs - how long the host must be offline before a vote can
 *     pass without them (defaults to HOST_OFFLINE_GRACE_MS)
 *   onStatsChanged() - called when presence or a GameRoom changed, so the
 *     launcher's room stats may have (X66); app.js passes the launcher
 *     reporter's markChanged
 */
export function createRealtimeHub({
    authenticate,
    store,
    isAdmin = () => false,
    logger = console,
    now = Date.now,
    voteTopics = {},
    voteHoldMs = VOTE_HOLD_MS,
    hostOfflineGraceMs = HOST_OFFLINE_GRACE_MS,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    livenessCheckIntervalMs = LIVENESS_CHECK_INTERVAL_MS,
    onStatsChanged = () => {},
}) {
    const context = createContext({
        store,
        isAdmin,
        logger,
        now,
        voteTopics,
        heartbeatIntervalMs,
        livenessCheckIntervalMs,
        onStatsChanged,
    });
    context.votes = createVoteTracker({
        topics: Object.keys(voteTopics),
        hostDecidesTopics: Object.keys(voteTopics).filter((topic) => voteTopics[topic].hostDecides === true),
        holdMs: voteHoldMs,
        hostGraceMs: hostOfflineGraceMs,
        now: () => context.clock.now(),
        onPassed(roomId, topic, option) {
            context.connections.runGuarded('vote', () => handleVotePassed(context, roomId, topic, option));
        },
        onChanged(changes) {
            context.connections.runGuarded('vote unlock', () => broadcastVoteChanges(context, changes));
        },
    });

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
         * room (EventPublisher#publishAll), then updates the published rooms' entry status and
         * the launcher's stats. `events` is [{ entity, type, record }]; `roomVersion` is the
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
                context.votes.dropSocket(socket, [roomId]);
            }
            refreshPresence(context, roomId, { force: true });
        },

        /**
         * Call after the room's host changed without a membership change (for
         * example make-host). A vote's voter minimum depends on whether the
         * host is online, so the room's votes are re-evaluated.
         */
        roomHostChanged(roomId) {
            const presence = context.presence.get(roomId);
            if (presence) {
                refreshVotes(context, roomId, presence.players);
            }
        },

        /** The launcher's room stats (roomStats.js), for the launcher reporter. */
        buildRoomStats() {
            return buildRoomStats(context);
        },

        /** Whether any of the room's players has a live socket subscribed to it right now. */
        hasPlayersOnline(roomId) {
            const presence = context.presence.get(roomId);
            if (!presence) {
                return false;
            }
            return presence.players.some((player) => player.online);
        },

        /** Runs the periodic checks (liveness, expired entries) now (tests drive them with a fake clock). */
        checkLiveness() {
            runPeriodicChecks(context);
        },

        close() {
            context.connections.close();
            context.votes.close();
            context.entries.close();
            context.wss.close();
        },
    };
}
