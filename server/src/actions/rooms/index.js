import { CloseAction } from './CloseAction.js';
import { DeleteRoomAction } from './DeleteRoomAction.js';
import { SetGameModeAction } from './SetGameModeAction.js';
import { StartAction } from './StartAction.js';

// The room actions run by name through the ActionRegistry. Room creation and the by-code lookup
// aren't among them: the rooms router runs CreateRoomAction for POST /api/rooms and
// LookupByCodeAction for GET /api/rooms/by-code/:code itself.

export { CreateRoomAction } from './CreateRoomAction.js';
export { LookupByCodeAction } from './LookupByCodeAction.js';

/** The registered room action handlers. `services` holds at least { roomService }. */
export function createRoomActions(services) {
    return [
        new SetGameModeAction(services),
        new StartAction(services),
        new CloseAction(services),
        new DeleteRoomAction(services),
    ];
}
