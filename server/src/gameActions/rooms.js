import { CloseAction } from '../actions/rooms/CloseAction.js';
import { CreateRoomAction } from '../actions/rooms/CreateRoomAction.js';
import { DeleteRoomAction } from '../actions/rooms/DeleteRoomAction.js';
import { LookupByCodeAction } from '../actions/rooms/LookupByCodeAction.js';
import { SetGameModeAction } from '../actions/rooms/SetGameModeAction.js';
import { StartAction } from '../actions/rooms/StartAction.js';
import { RoomService } from '../services/RoomService.js';

// The room actions' original function API, as thin adapters over RoomService and the handlers in
// actions/rooms/. Production uses those classes; these remain for the tests and the root test
// fixture, which import them by name. `tx` is a RoomUnitOfWork, `store` the store facade.

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

/** See LookupByCodeAction#lookup. */
export function lookupRoomByCode(store, user, rawCode) {
    const action = new LookupByCodeAction({ roomService: roomServiceFor(store) });
    return action.lookup(user, rawCode);
}
