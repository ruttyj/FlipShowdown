import { CloseAction } from './CloseAction.js';
import { DeleteRoomAction } from './DeleteRoomAction.js';
import { SetGameModeAction } from './SetGameModeAction.js';
import { StartAction } from './StartAction.js';

// The room actions run by name through the ActionRegistry. Room creation isn't one of them: the
// rooms router runs CreateRoomAction for POST /api/rooms directly.

export { CreateRoomAction } from './CreateRoomAction.js';

/** The registered room action handlers. `services` holds at least { roomService }. */
export function createRoomActions(services) {
    return [
        new SetGameModeAction(services),
        new StartAction(services),
        new CloseAction(services),
        new DeleteRoomAction(services),
    ];
}
