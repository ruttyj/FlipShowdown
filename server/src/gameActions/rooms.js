import { createServices } from '../actions/createGameActions.js';
import { CreateRoomAction } from '../actions/rooms/CreateRoomAction.js';
import { LookupByCodeAction } from '../actions/rooms/LookupByCodeAction.js';

// Test-facing adapters (see roomTx.js) for room creation and the by-code lookup, which the root
// test fixture (tests/fixtures/serverRoom.js) calls without the rooms router. `tx` is a
// RoomUnitOfWork and `store` the store facade.

/** Body of POST /api/rooms (runRoomAction with roomId null). Returns { player }. */
export function createRoom(tx, body) {
    const handler = new CreateRoomAction(createServices(tx.store.repositories));
    return handler.handle(tx, body);
}

/** See LookupByCodeAction#lookup. */
export function lookupRoomByCode(store, user, rawCode) {
    const action = new LookupByCodeAction(createServices(store.repositories));
    return action.lookup(user, rawCode);
}
