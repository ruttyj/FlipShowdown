import { StoreError } from '../entityTables.js';

// Shared machinery for game actions: load the room, check the caller's
// permission and the room's status, run the action body in one SQLite
// transaction, bump the room's version, then publish the changed records.

export const ROOM = 'GameRoom';
export const PLAYER = 'Player';
export const ROUND_SCORE = 'RoundScore';
export const CHAT_MESSAGE = 'ChatMessage';

/** Every status except `closed`. */
export const OPEN_STATUSES = ['waiting', 'playing', 'finished'];

/**
 * The "caller" of system actions (access 'system'). It has no email, so it
 * is never a member, host or admin.
 */
export const SYSTEM_USER = Object.freeze({ email: null });

// --- Errors --------------------------------------------------------------

/**
 * An expected failure. Thrown inside an action body it rolls the
 * transaction back and becomes `status` + `{ message, code, ...extra }`.
 */
export class ActionError extends Error {
    constructor(status, code, message, extra = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.extra = extra;
    }

    toBody() {
        return { message: this.message, code: this.code, ...this.extra };
    }
}

export function badRequest(message) {
    return new ActionError(400, 'bad_request', message);
}

// --- Change tracking -----------------------------------------------------

function isSameValue(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

/** The subset of `changes` whose values differ from `record`. */
function diffFields(record, changes) {
    const diff = {};
    for (const [field, value] of Object.entries(changes)) {
        if (!isSameValue(record[field], value)) {
            diff[field] = value;
        }
    }
    return diff;
}

function findEventIndex(tx, entity, id) {
    return tx.events.findIndex((event) => event.entity === entity && event.record.id === id);
}

/**
 * Queues a realtime event, keeping one event per record: a later update
 * replaces the queued record in place, and a delete drops whatever was
 * queued before (a record created and deleted in one action publishes nothing).
 */
function queueEvent(tx, entity, type, record) {
    const index = findEventIndex(tx, entity, record.id);
    if (index === -1) {
        tx.events.push({ entity, type, record });
        return;
    }

    const existing = tx.events[index];
    if (type === 'update') {
        existing.record = record;
        return;
    }

    tx.events.splice(index, 1);
    if (existing.type !== 'create') {
        tx.events.push({ entity, type, record });
    }
}

// --- Child records (Player, RoundScore, ChatMessage) ---------------------

export function createChild(tx, entity, fields) {
    const [record] = tx.store.createRecords(entity, [fields], tx.user.email);
    tx.changed = true;
    queueEvent(tx, entity, 'create', record);
    return record;
}

/** Writes only the fields that differ. Returns the current record either way. */
export function updateChild(tx, entity, record, changes) {
    const diff = diffFields(record, changes);
    if (Object.keys(diff).length === 0) {
        return record;
    }

    const updated = tx.store.updateRecord(entity, record.id, diff);
    tx.changed = true;
    queueEvent(tx, entity, 'update', updated);
    return updated;
}

export function deleteChild(tx, entity, record) {
    const deleted = tx.store.deleteRecord(entity, record.id);
    if (!deleted) {
        return;
    }
    tx.changed = true;
    queueEvent(tx, entity, 'delete', deleted);
}

/** Every record of `entity` whose room_id is the current room, oldest first. */
export function listRoomChildren(tx, entity) {
    return tx.store.findRecords(entity, 'room_id', tx.room.id);
}

// --- Players -------------------------------------------------------------

function byTurnOrder(left, right) {
    return (left.turn_order ?? 0) - (right.turn_order ?? 0);
}

/** The room's players sorted by turn_order. */
export function listPlayers(tx) {
    return listRoomChildren(tx, PLAYER).sort(byTurnOrder);
}

/** The caller's Player in the room, or null. */
export function findCallerPlayer(tx) {
    const players = listRoomChildren(tx, PLAYER);
    return players.find((player) => player.email === tx.user.email) || null;
}

/** The room's Player with this id, or a 404 `player_not_found`. */
export function getRoomPlayer(tx, playerId) {
    const player = tx.store.getRecord(PLAYER, playerId);
    if (!player || player.room_id !== tx.room.id) {
        throw new ActionError(404, 'player_not_found', 'Player not found');
    }
    return player;
}

/** Whether `player` is the host of `room` (a GameRoom record). */
export function isHostPlayer(room, player) {
    // Older rooms have no host_player_id, so the email decides there.
    return room.host_player_id === player.id || room.host_email === player.email;
}

// --- The room record -----------------------------------------------------

/**
 * Inserts a new GameRoom and makes it the action's room. It is published
 * as a `create` event (last, like any room change) when the action commits.
 */
export function insertRoom(tx, fields) {
    const [room] = tx.store.createRecords(ROOM, [{ ...fields, version: 0 }], tx.user.email);
    tx.room = room;
    tx.roomEventType = 'create';
    tx.changed = true;
    return room;
}

/** Stages room changes; they are written once, with the version bump, at commit. */
export function updateRoom(tx, changes) {
    const diff = diffFields(tx.room, changes);
    if (Object.keys(diff).length === 0) {
        return;
    }

    Object.assign(tx.pendingRoomChanges, diff);
    tx.room = { ...tx.room, ...diff };
    tx.changed = true;
}

/**
 * Writes the staged room changes now, bumping `version` and
 * `last_activity_date` once per action, and queues the room's event at the
 * current position. Normally the helper does this last; `delete` calls it
 * early so the `closed` update goes out before the deletes.
 */
export function flushRoom(tx) {
    const changes = { ...tx.pendingRoomChanges };
    if (!tx.versionBumped) {
        changes.version = (tx.room.version ?? 0) + 1;
        changes.last_activity_date = new Date().toISOString();
        tx.versionBumped = true;
    }

    tx.room = tx.store.updateRecord(ROOM, tx.room.id, changes);
    tx.pendingRoomChanges = {};
    queueEvent(tx, ROOM, tx.roomEventType, tx.room);
}

/** Deletes the room record itself. Call flushRoom first so the version is final. */
export function deleteRoomRecord(tx) {
    const deleted = tx.store.deleteRecord(ROOM, tx.room.id);
    tx.roomDeleted = true;
    // Pushed directly rather than through queueEvent: the `closed` update
    // queued by flushRoom must still go out before the deletes.
    tx.events.push({ entity: ROOM, type: 'delete', record: deleted });
}

function finishRoom(tx) {
    if (tx.roomDeleted || !tx.changed) {
        return;
    }
    flushRoom(tx);
}

// --- Permission and status checks ----------------------------------------

function loadRoom(tx, roomId) {
    const room = tx.store.getRecord(ROOM, roomId);
    if (!room) {
        throw new ActionError(404, 'room_not_found', 'Room not found');
    }
    tx.room = room;
    tx.initialHostEmail = room.host_email;
}

function isHost(tx) {
    return tx.isAdmin || tx.room.host_email === tx.user.email;
}

/**
 * access:
 *   'signed_in' - anyone signed in
 *   'member'    - the caller must have a Player (admins too: these actions
 *                 are about the caller's own Player)
 *   'host'      - the caller is room.host_email, or an admin
 *   'system'    - the server itself (a passed vote, user SYSTEM_USER); no check
 */
function checkAccess(tx, access) {
    if (access === 'signed_in' || access === 'system') {
        return;
    }

    const callerPlayer = findCallerPlayer(tx);
    if (access === 'member') {
        if (!callerPlayer) {
            throw new ActionError(403, 'not_member', 'You are not in this room');
        }
        return;
    }
    if (access === 'host') {
        if (isHost(tx)) {
            return;
        }
        if (!callerPlayer) {
            throw new ActionError(403, 'not_member', 'You are not in this room');
        }
        throw new ActionError(403, 'not_host', 'Only the host can do that');
    }

    // A typo in an action definition must not silently let everyone in.
    throw new Error(`Unknown access level: ${access}`);
}

/**
 * allowedStatuses: list of statuses, or null for any. Throws a 409
 * `wrong_status` otherwise. Exported for actions that check it themselves.
 */
export function checkStatus(tx, allowedStatuses) {
    if (allowedStatuses === null || allowedStatuses.includes(tx.room.status)) {
        return;
    }
    throw new ActionError(409, 'wrong_status', `Not allowed while the room is ${tx.room.status}`, {
        status: tx.room.status,
    });
}

// --- Running an action ---------------------------------------------------

function createTx(context, user) {
    return {
        store: context.store,
        user,
        isAdmin: context.config.adminEmails.has(user.email),
        room: null,
        // The room's host_email before the action, or null for a new room.
        initialHostEmail: null,
        roomEventType: 'update',
        pendingRoomChanges: {},
        versionBumped: false,
        roomDeleted: false,
        changed: false,
        events: [],
    };
}

// --- Publishing ----------------------------------------------------------

function hasMembershipChange(tx) {
    return tx.events.some((event) => event.entity === PLAYER && event.type !== 'update');
}

function hasHostChange(tx) {
    const isExistingRoom = tx.initialHostEmail !== null;
    return isExistingRoom && tx.room.host_email !== tx.initialHostEmail;
}

/** Tells the hub about changes that affect subscriptions, presence or votes. */
function notifyRoomChanges(hub, tx) {
    // Joins, leaves and kicks change who may subscribe and who counts as
    // online. That refresh also re-evaluates the votes, so it covers a host
    // change too.
    if (hasMembershipChange(tx)) {
        hub.roomMembershipChanged(tx.room.id);
        return;
    }
    // A vote's voter minimum depends on whether the host is online.
    if (hasHostChange(tx)) {
        hub.roomHostChanged(tx.room.id);
    }
}

/**
 * Publishes a committed action's events. The action has already committed,
 * so a failure here is logged rather than turned into an error response:
 * the client would otherwise retry an action that took effect.
 */
function publishEvents(context, tx) {
    try {
        context.hub.publishAll(tx.events, { roomVersion: tx.room.version });
    } catch (error) {
        context.logger.error(`Publishing events for room ${tx.room.id} failed`, error);
    }

    try {
        notifyRoomChanges(context.hub, tx);
    } catch (error) {
        context.logger.error(`Refreshing realtime state for room ${tx.room.id} failed`, error);
    }
}

/**
 * Runs one game action. `request` is:
 *   user            - the users row of the caller (req.user)
 *   roomId          - the room to act on, or null when the body creates one
 *                     with insertRoom (then access and status aren't checked)
 *   access          - 'signed_in' | 'member' | 'host' | 'system' (see checkAccess)
 *   allowedStatuses - statuses the action is allowed in, or null for any
 * `body(tx)` does the work through the helpers above and may return extra
 * response fields. Returns { status, body } ready to send: 200 with
 * `{ room, players, ...extra }`, or an ActionError's or StoreError's status and body.
 * Events are published only after the transaction commits. `context` is the
 * app context: { store, hub, config, logger }.
 */
export function runRoomAction(context, request, body) {
    const tx = createTx(context, request.user);

    let response;
    try {
        response = context.store.transaction(() => {
            if (request.roomId !== null) {
                loadRoom(tx, request.roomId);
                checkAccess(tx, request.access);
                checkStatus(tx, request.allowedStatuses);
            }

            const extra = body(tx) || {};
            finishRoom(tx);
            return { room: tx.room, players: listPlayers(tx), ...extra };
        });
    } catch (error) {
        // A StoreError is a write the database refused (say, a second open room with a code).
        const isExpectedFailure = error instanceof ActionError || error instanceof StoreError;
        if (isExpectedFailure) {
            return { status: error.status, body: error.toBody() };
        }
        throw error;
    }

    publishEvents(context, tx);
    return { status: 200, body: response };
}
