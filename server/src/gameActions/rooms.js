import { CloseAction } from '../actions/rooms/CloseAction.js';
import { CreateRoomAction } from '../actions/rooms/CreateRoomAction.js';
import { DeleteRoomAction } from '../actions/rooms/DeleteRoomAction.js';
import { SetGameModeAction } from '../actions/rooms/SetGameModeAction.js';
import { StartAction } from '../actions/rooms/StartAction.js';
import { ActionError } from '../domain/errors.js';
import { RoomService } from '../services/RoomService.js';

// The room actions' original function API, as thin adapters over RoomService and the handlers in
// actions/rooms/. Production routes use those classes; these remain for the callers not moved yet
// (the scoring actions' play-again, the stale-room sweep, until P3.3) and for the tests and the
// root test fixture, which import them by name. `tx` is a RoomUnitOfWork, `store` the store facade.

/** A RoomService on the store's repositories. Services are stateless, so a fresh one is fine. */
function roomServiceFor(store) {
    return new RoomService({
        roomRepository: store.repositories.rooms,
        playerRepository: store.repositories.players,
    });
}

/** Body of POST /api/rooms (runRoomAction with roomId null). Returns { player }. */
export function createRoom(tx, body) {
    const handler = new CreateRoomAction({ roomService: roomServiceFor(tx.store) });
    return handler.handle(tx, body);
}

/** See RoomService#resetPlayersForNewGame. */
export function resetPlayersForNewGame(tx) {
    roomServiceFor(tx.store).resetPlayersForNewGame(tx);
}

/** See RoomService#deleteRoom. */
export function deleteRoomCascade(tx) {
    roomServiceFor(tx.store).deleteRoom(tx);
}

/** A handler class as the old `{ access, allowedStatuses, run(tx, body) }` action object. */
function asActionObject(ActionClass) {
    const declaration = new ActionClass({ roomService: null });
    return {
        access: declaration.access,
        allowedStatuses: declaration.allowedStatuses,
        run(tx, body) {
            const handler = new ActionClass({ roomService: roomServiceFor(tx.store) });
            return handler.handle(tx, body);
        },
    };
}

export const setGameModeAction = asActionObject(SetGameModeAction);
export const startAction = asActionObject(StartAction);
export const closeAction = asActionObject(CloseAction);
export const deleteAction = asActionObject(DeleteRoomAction);

/**
 * GET /api/rooms/by-code/:code for the join screen (RoomService#lookupByCode), as
 * { status, body } ready to send.
 */
export function lookupRoomByCode(store, user, rawCode) {
    try {
        const body = roomServiceFor(store).lookupByCode(user.email, rawCode);
        return { status: 200, body };
    } catch (error) {
        if (error instanceof ActionError) {
            return { status: error.status, body: error.toBody() };
        }
        throw error;
    }
}
