// Pure client state for one game room: the room, its players, round scores and chat
// messages, plus presence. No React and no I/O, so it can be tested in node.
//
// Ordering rules (see "Realtime" in docs/backend-contract.md):
// - The highest room version applied is tracked. Events older than it are dropped.
// - Every event records which version it carried and when it touched a record
//   (`touched`: eventIndex plus room version). Snapshots merge per record: a record keeps
//   its local value (including "deleted") when the event that set it is newer than the
//   snapshot, and takes the snapshot's value otherwise. So a stale snapshot can't undo
//   newer events, but still brings back records missed while offline.
// - "Newer than the snapshot" means a higher room version than the snapshot's
//   `room.version`. Events written without a version (generic entity writes) can't be
//   ordered that way, so for them it means "applied after the fetch started" (`sinceEvent`).
// - Once the room is gone (closed or deleted), every later event is ignored, so the Player
//   deletes that follow a room delete don't look like "you were removed".

const ENTITY_COLLECTIONS = {
    Player: 'players',
    RoundScore: 'roundScores',
    ChatMessage: 'chatMessages',
};

/**
 * @typedef {object} RoomState
 * @property {object|null} room
 * @property {Object<string, object>} players       by id
 * @property {Object<string, object>} roundScores   by id
 * @property {Object<string, object>} chatMessages  by id
 * @property {Object<string, {online: boolean, last_seen: string|null}>} presence  by player id
 * @property {string|null} myPlayerId
 * @property {number} roomVersion   highest room version applied, -1 before any
 * @property {number} eventIndex    count of events applied
 * @property {Object<string, {eventIndex: number, version: number|null}>} touched
 *           "Entity:id" -> the last event for that record
 * @property {boolean} roomGone
 * @property {boolean} removedFromRoom
 */

/** @returns {RoomState} */
export function createRoomState() {
    return {
        room: null,
        players: {},
        roundScores: {},
        chatMessages: {},
        presence: {},
        myPlayerId: null,
        roomVersion: -1,
        eventIndex: 0,
        touched: {},
        roomGone: false,
        removedFromRoom: false,
    };
}

// --- Helpers -----------------------------------------------------------------

function touchKey(entity, id) {
    return `${entity}:${id}`;
}

function isClosed(room) {
    return room?.status === 'closed';
}

/** A version older than the newest applied one; null means "unversioned" and never is. */
function isOlderVersion(state, version) {
    if (version === null || version === undefined) {
        return false;
    }
    return version < state.roomVersion;
}

function raiseVersion(state, version) {
    if (version === null || version === undefined) {
        return state.roomVersion;
    }
    return Math.max(state.roomVersion, version);
}

function belongsToRoom(state, entity, event) {
    const roomId = state.room?.id;
    if (!roomId) {
        return false;
    }

    if (entity === 'GameRoom') {
        return event.id === roomId;
    }
    return event.data?.room_id === roomId;
}

function withRecord(collection, event) {
    const next = { ...collection };
    if (event.type === 'delete') {
        delete next[event.id];
    } else {
        next[event.id] = event.data;
    }
    return next;
}

// --- Events ------------------------------------------------------------------

function applyRoomEvent(state, event) {
    const isGone = event.type === 'delete' || isClosed(event.data);
    if (isGone) {
        // A Player delete that arrived just before this was the room closing, not a kick.
        return { ...state, room: event.data ?? state.room, roomGone: true, removedFromRoom: false };
    }
    return { ...state, room: event.data };
}

function applyChildEvent(state, entity, event) {
    const collectionName = ENTITY_COLLECTIONS[entity];
    const next = { ...state, [collectionName]: withRecord(state[collectionName], event) };

    const isMyPlayer = entity === 'Player' && event.id === state.myPlayerId;
    if (isMyPlayer && event.type === 'delete') {
        next.removedFromRoom = true;
    }
    if (isMyPlayer && event.type !== 'delete') {
        next.removedFromRoom = false;
    }
    return next;
}

/**
 * Applies one realtime entity event.
 *
 * @param {RoomState} state
 * @param {'GameRoom'|'Player'|'RoundScore'|'ChatMessage'} entity
 * @param {{type: 'create'|'update'|'delete', id: string, data: object}} event
 *        For `delete`, `data` is the record as it was before deletion.
 * @param {{roomVersion?: number|null}} [meta]
 * @returns {RoomState} the same object when the event is ignored
 */
export function applyEvent(state, entity, event, meta = {}) {
    const isKnownEntity = entity === 'GameRoom' || entity in ENTITY_COLLECTIONS;
    if (!isKnownEntity || state.roomGone || !belongsToRoom(state, entity, event)) {
        return state;
    }

    const version = meta.roomVersion ?? null;
    if (isOlderVersion(state, version)) {
        return state;
    }

    let next;
    if (entity === 'GameRoom') {
        next = applyRoomEvent(state, event);
    } else {
        next = applyChildEvent(state, entity, event);
    }

    const eventIndex = state.eventIndex + 1;
    return {
        ...next,
        roomVersion: raiseVersion(next, version),
        eventIndex,
        touched: { ...state.touched, [touchKey(entity, event.id)]: { eventIndex, version } },
    };
}

// --- Snapshots ---------------------------------------------------------------

/**
 * Whether the last event for a record is newer than the snapshot, so the record keeps its
 * local value. `snapshotAge` is {version, sinceEvent} (see the top of this file).
 */
function isTouchNewer(touch, snapshotAge) {
    if (touch === undefined) {
        return false;
    }
    if (touch.version === null) {
        return touch.eventIndex > snapshotAge.sinceEvent;
    }
    return touch.version > snapshotAge.version;
}

function isLocalNewer(state, entity, id, snapshotAge) {
    return isTouchNewer(state.touched[touchKey(entity, id)], snapshotAge);
}

/**
 * Merges a fetched collection per record: the snapshot's records replace local ones and
 * local records it lacks are removed, except where a newer event set the local state
 * (present or deleted).
 */
function mergeCollection(state, entity, fetchedRecords, snapshotAge) {
    const collectionName = ENTITY_COLLECTIONS[entity];
    const current = state[collectionName];
    const merged = {};

    for (const record of fetchedRecords ?? []) {
        if (!isLocalNewer(state, entity, record.id, snapshotAge)) {
            merged[record.id] = record;
        }
    }

    for (const [id, record] of Object.entries(current)) {
        if (isLocalNewer(state, entity, id, snapshotAge)) {
            merged[id] = record;
        }
    }

    return merged;
}

/**
 * The local room wins when it has a higher version than the snapshot's, or an event newer
 * than the snapshot set it.
 */
function mergeRoom(state, fetchedRoom, snapshotAge) {
    const localRoom = state.room;
    if (localRoom?.id !== fetchedRoom.id) {
        return fetchedRoom;
    }

    const isLocalVersionHigher = (localRoom.version ?? 0) > snapshotAge.version;
    if (isLocalVersionHigher || isLocalNewer(state, 'GameRoom', fetchedRoom.id, snapshotAge)) {
        return localRoom;
    }
    return fetchedRoom;
}

/** Only touches newer than this snapshot can matter to a later (newer) snapshot. */
function pruneTouched(touched, snapshotAge) {
    /** @type {RoomState['touched']} */
    const kept = {};
    for (const [key, touch] of Object.entries(touched)) {
        if (isTouchNewer(touch, snapshotAge)) {
            kept[key] = touch;
        }
    }
    return kept;
}

/**
 * I was removed if I'm not a member after the merge and either an event already said so,
 * or I had a Player before this snapshot and it's gone from the merged list. A stale
 * snapshot can still name my Player after a newer event deleted it, so membership is
 * checked against the merged players, not only `myPlayerId`.
 */
function isRemovedAfterSnapshot(state, players, myPlayerId) {
    const isMemberNow = myPlayerId !== null && myPlayerId in players;
    if (isMemberNow) {
        return false;
    }
    if (state.removedFromRoom) {
        return true;
    }

    const hadMyPlayer = state.myPlayerId !== null && state.myPlayerId in state.players;
    return hadMyPlayer && !(state.myPlayerId in players);
}

/**
 * Applies a full refetch of the room, merged per record with newer events (see the top of
 * this file). A snapshot older than the applied version still adds and removes the records
 * no newer event has set.
 *
 * @param {RoomState} state
 * @param {{room: object, players?: object[], roundScores?: object[], chatMessages?: object[],
 *          myPlayerId?: string|null, sinceEvent?: number}} snapshot
 *        `sinceEvent` is `state.eventIndex` when the fetch was started; it defaults to the
 *        current index (no unversioned event counts as newer than the snapshot).
 * @returns {RoomState} the same object when the room is already gone
 */
export function applySnapshot(state, snapshot) {
    const { room } = snapshot;
    const isNewRoom = state.room !== null && state.room.id !== room.id;
    const base = isNewRoom ? createRoomState() : state;

    // A gone room never comes back.
    if (base.roomGone) {
        return state;
    }

    const snapshotAge = {
        version: room.version ?? 0,
        sinceEvent: snapshot.sinceEvent ?? base.eventIndex,
    };
    const myPlayerId = snapshot.myPlayerId ?? null;
    const players = mergeCollection(base, 'Player', snapshot.players, snapshotAge);
    const mergedRoom = mergeRoom(base, room, snapshotAge);
    const roomGone = isClosed(mergedRoom);

    return {
        ...base,
        room: mergedRoom,
        players,
        roundScores: mergeCollection(base, 'RoundScore', snapshot.roundScores, snapshotAge),
        chatMessages: mergeCollection(base, 'ChatMessage', snapshot.chatMessages, snapshotAge),
        myPlayerId,
        roomVersion: raiseVersion(base, snapshotAge.version),
        touched: pruneTouched(base.touched, snapshotAge),
        roomGone,
        // Losing my Player because the room closed isn't being removed.
        removedFromRoom: !roomGone && isRemovedAfterSnapshot(base, players, myPlayerId),
    };
}

/** The room was closed, deleted, or a refetch said it doesn't exist. */
export function markRoomGone(state) {
    if (state.roomGone) {
        return state;
    }
    // A Player delete seen just before was part of the room going away, not a kick.
    return { ...state, roomGone: true, removedFromRoom: false };
}

// --- Presence ----------------------------------------------------------------

/**
 * Merges a room's presence ([{playerId, online, lastSeen}]). Entries update the players they
 * name; players not listed keep their last known presence.
 */
export function applyPresence(state, roomId, players) {
    if (!state.room || roomId !== state.room.id) {
        return state;
    }

    const presence = { ...state.presence };
    for (const entry of players) {
        presence[entry.playerId] = {
            online: entry.online === true,
            last_seen: entry.lastSeen ?? presence[entry.playerId]?.last_seen ?? null,
        };
    }
    return { ...state, presence };
}

// --- Selectors ---------------------------------------------------------------

/** Players by turn order, each with `online` and `last_seen` from presence merged in. */
export function selectSortedPlayers(state) {
    const players = [];
    for (const player of Object.values(state.players)) {
        const presence = state.presence[player.id];
        players.push({
            ...player,
            online: presence?.online ?? false,
            last_seen: presence?.last_seen ?? player.last_seen ?? null,
        });
    }

    players.sort((a, b) => (a.turn_order ?? 0) - (b.turn_order ?? 0));
    return players;
}

/** My Player record, or null when I haven't joined (or was removed). */
export function selectMyPlayer(state) {
    if (state.myPlayerId === null) {
        return null;
    }
    return state.players[state.myPlayerId] ?? null;
}

export function selectIsHost(state) {
    return selectMyPlayer(state)?.is_host === true;
}

/** Edit mode comes from the room, so it survives the host refreshing (bug 3.6). */
export function selectIsEditMode(state) {
    return state.room?.is_edit_mode === true;
}

/** Round scores ordered by round, then player. */
export function selectRoundScores(state) {
    const scores = Object.values(state.roundScores);
    scores.sort((a, b) => {
        if (a.round_number !== b.round_number) {
            return a.round_number - b.round_number;
        }
        return String(a.player_id).localeCompare(String(b.player_id));
    });
    return scores;
}

/** @returns {Object<number, object[]>} round number -> that round's scores */
export function selectScoresByRound(state) {
    /** @type {Object<number, object[]>} */
    const scoresByRound = {};
    for (const score of selectRoundScores(state)) {
        if (!scoresByRound[score.round_number]) {
            scoresByRound[score.round_number] = [];
        }
        scoresByRound[score.round_number].push(score);
    }
    return scoresByRound;
}
