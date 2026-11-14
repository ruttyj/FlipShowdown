import { OPEN_STATUSES } from '../../domain/entities.js';
import { requireGameMode } from '../../services/RoomService.js';

// POST /api/rooms/:roomId/actions/set-game-mode with { game_mode }: the host switches the room's
// game mode until someone scores (RoomService#setGameMode).

export class SetGameModeAction {
    name = 'set-game-mode';
    access = 'host';
    allowedStatuses = OPEN_STATUSES;

    constructor({ roomService }) {
        this.roomService = roomService;
    }

    handle(work, body) {
        const gameMode = requireGameMode(body.game_mode);
        this.roomService.setGameMode(work, gameMode);
    }
}
