import { WebSocketServer, WebSocket } from 'ws';
import {
    CLIENT_MESSAGE,
    LIVE_WINDOW_MS,
    REALTIME_PATH,
    SERVER_MESSAGE,
    VOTE_HOLD_MS,
} from '../../shared/realtimeProtocol.js';
import { createEntryStatusTracker, isEntryState } from './entryStatus.js';
import { isHostPlayer } from './gameActions/roomTx.js';
import { buildRoomStats } from './roomStats.js';
import { createVoteTracker, HOST_OFFLINE_GRACE_MS } from './votes.js';

// WebSocket ping frames, only for terminating dead sockets. Their pongs don't
// count as liveness: the browser answers them even for a hidden tab.
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_CLIENT_MESSAGE_BYTES = 16 * 1024;
const LIVENESS_CHECK_INTERVAL_MS = 5_000;
const ALL_ROOMS = '*';

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

function send(socket, message) {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(typeof message === 'string' ? message : JSON.stringify(message));
    }
}

// --- Room membership -----------------------------------------------------
// A Player's email comes from the users table, so it is canonical: the same
// spelling auth gives socket identities (email.js). Plain === compares them.

function playersInRoom(store, roomId) {
    return store.findRecords('Player', 'room_id', roomId);
}

/** Ids of the rooms where this (normalised) email has a Player. */
function roomIdsOfUser(store, email) {
    const roomIds = new Set();
    for (const player of store.findRecordsByEmail('Player', email)) {
        if (typeof player.room_id === 'string') {
            roomIds.add(player.room_id);
        }
    }
    return roomIds;
}

function isMember(store, email, roomId) {
    return playersInRoom(store, roomId).some((player) => player.email === email);
}

/**
 * Turns a client's requested room list into { rooms: Set, allRooms }. Rooms the
 * user isn't a member of are dropped, and "*" only counts for admins.
 */
function resolveSubscription(context, identity, requested) {
    const subscription = { rooms: new Set(), allRooms: false };
    if (!Array.isArray(requested)) {
        return subscription;
    }

    const memberRooms = roomIdsOfUser(context.store, identity.email);
    for (const roomId of requested) {
        if (roomId === ALL_ROOMS) {
            subscription.allRooms = context.isAdmin(identity);
            continue;
        }
        if (memberRooms.has(roomId)) {
            subscription.rooms.add(roomId);
        }
    }
    return subscription;
}

/**
 * Replaces the socket's subscription. Returns the rooms that were added and
 * every room whose presence may have changed (old and new).
 */
function applySubscription(socket, subscription) {
    const previousRooms = socket.rooms;
    const added = [];
    for (const roomId of subscription.rooms) {
        if (!previousRooms.has(roomId)) {
            added.push(roomId);
        }
    }

    const removed = [];
    for (const roomId of previousRooms) {
        if (!subscription.rooms.has(roomId)) {
            removed.push(roomId);
        }
    }

    socket.rooms = subscription.rooms;
    socket.allRooms = subscription.allRooms;
    socket.isSubscribed = true;

    const affected = new Set([...previousRooms, ...subscription.rooms]);
    return { added, removed, affected };
}

// --- Event routing -------------------------------------------------------

/** A GameRoom belongs to itself; everything else to its room_id. Null when neither. */
function eventRoomId(entity, record) {
    const roomId = entity === 'GameRoom' ? record.id : record.room_id;
    if (typeof roomId !== 'string' || roomId === '') {
        return null;
    }
    return roomId;
}

/**
 * Whether an event for `roomId` reaches this socket. Explicit room subscriptions
 * were membership-checked, so they may also see chat. Admin "*" sockets see
 * everything except chat for rooms they aren't in.
 */
function canReceive(context, socket, roomId, entity) {
    if (!socket.isSubscribed) {
        return false;
    }
    if (socket.rooms.has(roomId)) {
        return true;
    }
    if (!socket.allRooms) {
        return false;
    }
    if (entity === 'ChatMessage') {
        return isMember(context.store, socket.identity.email, roomId);
    }
    return true;
}

function sendEvent(context, roomId, entity, text) {
    for (const socket of context.wss.clients) {
        if (canReceive(context, socket, roomId, entity)) {
            send(socket, text);
        }
    }
}

function buildEventText(seq, entity, type, record, roomVersion) {
    return JSON.stringify({
        type: SERVER_MESSAGE.EVENT,
        seq,
        entity,
        event: { type, id: record.id, data: record, timestamp: new Date().toISOString() },
        room_version: roomVersion ?? null,
    });
}

// --- Presence ------------------------------------------------------------

function isSubscribedToRoom(socket, roomId) {
    return socket.isSubscribed && (socket.rooms.has(roomId) || socket.allRooms);
}

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
    for (const player of playersInRoom(context.store, roomId)) {
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

    const timestamp = new Date(context.now()).toISOString();
    for (const player of players) {
        if (!player.online && wasOnline.has(player.player_id)) {
            context.store.updateRecord('Player', player.player_id, { last_seen: timestamp });
            player.last_seen = timestamp;
        }
    }
}

/**
 * Whether any socket explicitly subscribes to the room. Admin "*" sockets
 * don't count: otherwise a deleted room's vote and presence state would be
 * kept for as long as an admin stays connected.
 */
function hasSubscribers(context, roomId) {
    for (const socket of context.wss.clients) {
        if (socket.isSubscribed && socket.rooms.has(roomId)) {
            return true;
        }
    }
    return false;
}

function sendToRoom(context, roomId, message, skipSocket = null) {
    const text = JSON.stringify(message);
    for (const socket of context.wss.clients) {
        if (socket !== skipSocket && isSubscribedToRoom(socket, roomId)) {
            send(socket, text);
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
        sendToRoom(context, roomId, buildVoteMessage(context, roomId, topic), skipSocket);
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
    if (!hasSubscribers(context, roomId)) {
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
    const hostPlayerId = hostPlayerIdOf(room, playersInRoom(context.store, roomId));
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
    if (hasSubscribers(context, roomId)) {
        context.presence.set(roomId, { players, text });
    } else {
        context.presence.delete(roomId);
    }

    if (hasChanged || force) {
        for (const socket of context.wss.clients) {
            if (socket !== skipSocket && isSubscribedToRoom(socket, roomId)) {
                send(socket, text);
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
    sendToRoom(context, roomId, buildEntryStatusMessage(context, roomId));
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
    const players = playersInRoom(context.store, roomId);
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
            send(socket, presence.text);
        }
        for (const topic of Object.keys(context.voteTopics)) {
            send(socket, buildVoteMessage(context, roomId, topic));
        }
        const entryStatus = buildEntryStatusMessage(context, roomId);
        if (entryStatus.entries.length > 0) {
            send(socket, entryStatus);
        }
    }
}

/** Records a client ping. A socket that had gone stale is live again. */
function markHeard(context, socket) {
    socket.lastHeardAt = context.now();
    if (socket.isLive) {
        return;
    }

    socket.isLive = true;
    refreshRooms(context, socket.rooms);
}

/** Marks sockets without a recent client ping as not live and updates their rooms. */
function checkLiveness(context) {
    const changedRooms = new Set();
    for (const socket of context.wss.clients) {
        const isLive = context.now() - socket.lastHeardAt <= LIVE_WINDOW_MS;
        if (isLive === socket.isLive) {
            continue;
        }

        socket.isLive = isLive;
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
    const rooms = socket.rooms;
    socket.isSubscribed = false;
    socket.rooms = new Set();
    socket.allRooms = false;
    broadcastVoteChanges(context, context.votes.dropSocket(socket));
    refreshRooms(context, rooms);
}

// --- Hello / rooms -------------------------------------------------------

/**
 * Decides how to answer a hello:
 *   'fresh'  - client has no position (first connect), nothing to replay
 *   'replay' - same epoch and every event after last_seq is still stored
 *   'resync' - the event log was lost, or the client is too far behind / ahead
 */
function classifyHello(eventLog, epoch, lastSeq) {
    const hasPosition = typeof epoch === 'string' && epoch !== '';
    if (!hasPosition) {
        return 'fresh';
    }
    if (epoch !== eventLog.epoch) {
        return 'resync';
    }
    if (!Number.isInteger(lastSeq)) {
        return 'fresh';
    }

    const oldestStoredSeq = eventLog.oldestSeq() ?? eventLog.lastSeq + 1;
    const isAheadOfServer = lastSeq > eventLog.lastSeq;
    // Replay needs the event right after last_seq to still be stored.
    const isGapTooOld = lastSeq + 1 < oldestStoredSeq;
    if (isAheadOfServer || isGapTooOld) {
        return 'resync';
    }
    return 'replay';
}

function replayEvents(context, socket, lastSeq) {
    const roomIds = socket.allRooms ? null : [...socket.rooms];
    for (const row of context.eventLog.readAfter(lastSeq, roomIds)) {
        if (canReceive(context, socket, row.room_id, row.entity)) {
            send(socket, row.text);
        }
    }
}

function handleHello(context, socket, message) {
    const subscription = resolveSubscription(context, socket.identity, message.rooms);
    const outcome = classifyHello(context.eventLog, message.epoch, message.last_seq);
    // Everything from here to ready runs in one tick, so no live event can
    // slip between the replay and the socket receiving live events.
    const { removed, affected } = applySubscription(socket, subscription);
    dropHoldsInRooms(context, socket, removed);

    if (outcome === 'resync') {
        send(socket, { type: SERVER_MESSAGE.RESYNC });
    }
    if (outcome === 'replay') {
        replayEvents(context, socket, message.last_seq);
    }

    send(socket, { type: SERVER_MESSAGE.READY, epoch: context.eventLog.epoch, seq: context.eventLog.lastSeq });
    refreshRooms(context, affected, { skipSocket: socket });
    sendRoomStates(context, socket, subscription.rooms);
}

function handleRooms(context, socket, message) {
    // A room list only makes sense once hello has set the socket's position.
    if (!socket.isSubscribed) {
        return;
    }

    const subscription = resolveSubscription(context, socket.identity, message.rooms);
    const { added, removed, affected } = applySubscription(socket, subscription);
    dropHoldsInRooms(context, socket, removed);

    send(socket, { type: SERVER_MESSAGE.ROOMS_OK, seq: context.eventLog.lastSeq });
    refreshRooms(context, affected, { skipSocket: socket });
    sendRoomStates(context, socket, added);
}

// --- Vote messages -------------------------------------------------------

function sendVoteError(socket, message, code) {
    send(socket, { type: SERVER_MESSAGE.VOTE_ERROR, room_id: message.room_id ?? null, topic: message.topic ?? null, code });
}

function isExplicitlySubscribed(socket, roomId) {
    return socket.isSubscribed && socket.rooms.has(roomId);
}

/**
 * The sender's Player in the room, or null. Only explicit subscriptions count:
 * an admin "*" socket is watching, not playing.
 */
function findSubscribedPlayer(context, socket, roomId) {
    if (!isExplicitlySubscribed(socket, roomId)) {
        return null;
    }

    const player = playersInRoom(context.store, roomId).find((candidate) => {
        return candidate.email === socket.identity.email;
    });
    return player ?? null;
}

/**
 * Checks a vote-hold / vote-release and finds the sender's Player. Returns
 * { roomId, topic, player }, or null after replying with a vote-error.
 */
function resolveVoter(context, socket, message) {
    const { room_id: roomId, topic } = message;
    const hasFields = typeof roomId === 'string' && typeof topic === 'string';
    if (!hasFields) {
        sendVoteError(socket, message, 'bad_request');
        return null;
    }
    if (!Object.hasOwn(context.voteTopics, topic)) {
        sendVoteError(socket, message, 'unknown_topic');
        return null;
    }

    const player = findSubscribedPlayer(context, socket, roomId);
    if (!player) {
        sendVoteError(socket, message, 'not_member');
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
    const players = playersInRoom(context.store, voter.roomId);
    const isValid = typeof message.option === 'string'
        && context.voteTopics[voter.topic].validateOption(room, players, message.option);
    if (!isValid) {
        sendVoteError(socket, message, 'invalid_option');
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
    const isStillValid = definition.validateOption(room, playersInRoom(context.store, roomId), option);

    broadcastVoteChanges(context, [{ roomId, topic }]);
    if (!isStillValid) {
        return;
    }

    const result = definition.resolve(roomId, option);
    if (result.status !== 200) {
        context.logger.warn(`Vote ${topic} in room ${roomId} failed: ${result.body.code}`);
        return;
    }
    sendToRoom(context, roomId, { type: SERVER_MESSAGE.VOTE_PASSED, room_id: roomId, topic, option });
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
    if (!hasFields || !isExplicitlySubscribed(socket, roomId)) {
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
            guarded(context, 'held entry status', () => applyEntryStatus(context, socket, message));
        };
        isAdmitted = context.entries.admitAnnounce(roomId, who, { state, round }, applyHeld);
    }
    if (isAdmitted) {
        applyEntryStatus(context, socket, message);
    }
}

/** Puts a checked and admitted status into effect, and tells the room if that changed anything. */
function applyEntryStatus(context, socket, { room_id: roomId, state, round }) {
    const player = findSubscribedPlayer(context, socket, roomId);
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
        markHeard(context, socket);
        send(socket, { type: SERVER_MESSAGE.PONG });
    }
}

// --- Heartbeat -----------------------------------------------------------

/** Terminates sockets that didn't answer the previous ping, then pings the rest. */
function heartbeat(wss) {
    for (const socket of wss.clients) {
        if (!socket.isAlive) {
            socket.terminate();
            continue;
        }
        socket.isAlive = false;
        socket.ping();
    }
}

// --- Hub -----------------------------------------------------------------

/** Runs a socket or timer handler, logging instead of crashing the process. */
function guarded(context, label, handler) {
    if (context.isClosed) {
        return;
    }
    try {
        handler();
    } catch (error) {
        context.logger.error(`Realtime ${label} failed`, error);
    }
}

function setUpSocket(context, socket) {
    socket.isAlive = true;
    socket.isLive = true;
    socket.lastHeardAt = context.now();
    socket.isSubscribed = false;
    socket.rooms = new Set();
    socket.allRooms = false;

    // Only proves the connection is up (see HEARTBEAT_INTERVAL_MS), not that the page is live.
    socket.on('pong', () => {
        socket.isAlive = true;
    });
    socket.on('message', (raw) => {
        guarded(context, 'message', () => handleClientMessage(context, socket, raw));
    });
    socket.on('close', () => {
        guarded(context, 'close', () => handleSocketClosed(context, socket));
    });
    socket.on('error', (error) => {
        context.logger.warn(`Realtime socket error: ${error.message}`);
    });
}

function startTimers(context, { heartbeatIntervalMs, livenessCheckIntervalMs }) {
    const heartbeatTimer = setInterval(() => heartbeat(context.wss), heartbeatIntervalMs);
    const livenessTimer = setInterval(() => {
        guarded(context, 'periodic check', () => runPeriodicChecks(context));
    }, livenessCheckIntervalMs);
    heartbeatTimer.unref();
    livenessTimer.unref();
    return [heartbeatTimer, livenessTimer];
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
 *     resolve, hostDecides } (see gameActions/voteTopics.js); none by default
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
    const context = {
        store,
        eventLog: store.eventLog,
        isAdmin,
        logger,
        now,
        wss: new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES }),
        // roomId -> { players, text } as last sent, to detect changes.
        presence: new Map(),
        voteTopics,
        votes: null,
        entries: createEntryStatusTracker({ now }),
        isClosed: false,
        onStatsChanged,
    };
    context.votes = createVoteTracker({
        topics: Object.keys(voteTopics),
        hostDecidesTopics: Object.keys(voteTopics).filter((topic) => voteTopics[topic].hostDecides === true),
        holdMs: voteHoldMs,
        hostGraceMs: hostOfflineGraceMs,
        now,
        onPassed(roomId, topic, option) {
            guarded(context, 'vote', () => handleVotePassed(context, roomId, topic, option));
        },
        onChanged(changes) {
            guarded(context, 'vote unlock', () => broadcastVoteChanges(context, changes));
        },
    });

    context.wss.on('connection', (socket) => setUpSocket(context, socket));
    const timers = startTimers(context, { heartbeatIntervalMs, livenessCheckIntervalMs });

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
            // The accepted WebSocket now owns the raw socket's errors (see setUpSocket).
            socket.off('error', onSocketError);
            webSocket.identity = identity;
            context.wss.emit('connection', webSocket, request);
        });
    }

    return {
        get epoch() {
            return context.eventLog.epoch;
        },

        get seq() {
            return context.eventLog.lastSeq;
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
         * Stores entity changes in the event log, all in one transaction, and
         * sends each to the sockets subscribed to its room. `events` is
         * [{ entity, type, record }]. `roomVersion` is the room's version after
         * the action that produced them (null for generic entity writes).
         * Throws only when storing fails, and then sends nothing; a failed
         * send is logged and the remaining events still go out.
         */
        publishAll(events, { roomVersion } = {}) {
            const entries = [];
            for (const event of events) {
                entries.push({
                    roomId: eventRoomId(event.entity, event.record),
                    entity: event.entity,
                    buildText: (seq) => buildEventText(seq, event.entity, event.type, event.record, roomVersion),
                });
            }
            const stored = context.eventLog.appendAll(entries);

            for (const [index, entry] of entries.entries()) {
                guarded(context, `${entry.entity} event`, () => {
                    sendEvent(context, entry.roomId, entry.entity, stored[index].text);
                });
            }

            // After the events, so a client hears "Sam submitted" before the banner drops.
            const roomIds = new Set(entries.map((entry) => entry.roomId));
            for (const roomId of roomIds) {
                guarded(context, 'entry status', () => reconcileEntries(context, roomId));
            }

            // A room's status, round or max score shows in its launcher row (X66).
            if (entries.some((entry) => entry.entity === 'GameRoom')) {
                context.onStatsChanged();
            }
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
            for (const socket of context.wss.clients) {
                const isDropped = socket.rooms.has(roomId)
                    && !isMember(store, socket.identity.email, roomId);
                if (isDropped) {
                    socket.rooms.delete(roomId);
                    // No broadcast needed: the forced refresh below sends every topic.
                    context.votes.dropSocket(socket, [roomId]);
                }
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
            context.isClosed = true;
            context.votes.close();
            context.entries.close();
            for (const timer of timers) {
                clearInterval(timer);
            }
            for (const socket of context.wss.clients) {
                socket.terminate();
            }
            context.wss.close();
        },
    };
}
