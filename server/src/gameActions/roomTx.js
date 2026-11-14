import { AccessPolicy } from '../actions/AccessPolicy.js';
import { RoomActionRunner } from '../actions/RoomActionRunner.js';
import { CHAT_MESSAGE, OPEN_STATUSES, PLAYER, ROOM, ROUND_SCORE, SYSTEM_USER } from '../domain/entities.js';
import { ActionError, badRequest } from '../domain/errors.js';

// The game actions' original function API, as thin adapters over actions/: `tx` is a
// RoomUnitOfWork and runRoomAction runs a RoomActionRunner. The action modules and tests still call
// these; the services that replace the action modules (P3.2) call the classes directly.

// Moved to domain/; re-exported so existing importers keep working.
export { ActionError, CHAT_MESSAGE, OPEN_STATUSES, PLAYER, ROOM, ROUND_SCORE, SYSTEM_USER, badRequest };

// --- Unit of work adapters -----------------------------------------------

export function createChild(tx, entity, fields) {
    return tx.createChild(entity, fields);
}

/** Writes only the fields that differ. Returns the current record either way. */
export function updateChild(tx, entity, record, changes) {
    return tx.updateChild(entity, record, changes);
}

export function deleteChild(tx, entity, record) {
    tx.deleteChild(entity, record);
}

/** Every record of `entity` whose room_id is the current room, oldest first. */
export function listRoomChildren(tx, entity) {
    return tx.listRoomChildren(entity);
}

/** The room's players sorted by turn_order. */
export function listPlayers(tx) {
    return tx.listPlayers();
}

/** The caller's Player in the room, or null. */
export function findCallerPlayer(tx) {
    return tx.findCallerPlayer();
}

/** The room's Player with this id, or a 404 `player_not_found`. */
export function getRoomPlayer(tx, playerId) {
    return tx.getRoomPlayer(playerId);
}

/** See RoomUnitOfWork#insertRoom. */
export function insertRoom(tx, fields) {
    return tx.insertRoom(fields);
}

/** Stages room changes; they are written once, with the version bump, at the end of the action. */
export function updateRoom(tx, changes) {
    tx.updateRoom(changes);
}

/** See RoomUnitOfWork#flushRoom. */
export function flushRoom(tx) {
    tx.flushRoom();
}

/** Deletes the room record itself. Call flushRoom first so the version is final. */
export function deleteRoomRecord(tx) {
    tx.deleteRoomRecord();
}

/**
 * allowedStatuses: list of statuses, or null for any. Throws a 409 `wrong_status` otherwise. For
 * actions that check it themselves.
 */
export function checkStatus(tx, allowedStatuses) {
    tx.requireStatus(allowedStatuses);
}

// --- Host --------------------------------------------------------------------

/** Whether `player` is the host of `room` (a GameRoom record). */
export function isHostPlayer(room, player) {
    // Older rooms have no host_player_id, so the email decides there.
    return room.host_player_id === player.id || room.host_email === player.email;
}

// --- Running an action -------------------------------------------------------

/**
 * A RoomActionRunner for the app context ({ store, hub, config, logger }). The hub is read from
 * the context each time the runner publishes, since the app sets it after building the context.
 */
export function createRoomActionRunner(context) {
    return new RoomActionRunner({
        database: context.store.database,
        repositories: context.store.repositories,
        store: context.store,
        accessPolicy: new AccessPolicy(),
        adminEmails: context.config.adminEmails,
        getHub: () => context.hub,
        logger: context.logger,
    });
}

/**
 * Runs one game action (see RoomActionRunner#run). `request` is { user, roomId, access,
 * allowedStatuses }; `body(tx)` does the work and may return extra response fields. Returns
 * { status, body } ready to send. `context` is the app context: { store, hub, config, logger }.
 */
export function runRoomAction(context, request, body) {
    const handler = {
        access: request.access,
        allowedStatuses: request.allowedStatuses,
        handle: (tx) => body(tx),
    };
    return createRoomActionRunner(context).run(handler, { user: request.user, roomId: request.roomId });
}
