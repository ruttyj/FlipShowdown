import { DEFAULT_GAME_MODE } from '../../../../shared/rules.js';
import { badRequest } from '../../domain/errors.js';
import { normaliseName } from '../../services/auth.js';
import { requireGameMode } from '../../services/RoomService.js';

// POST /api/rooms with { max_score, game_mode?, name? }: anyone signed in creates a room and
// becomes its host (RoomService#createRoom). The runner runs it with roomId null, so there is no
// room yet whose access or status to check. It isn't in the ActionRegistry, so it has no action
// name: the rooms router runs it for POST /api/rooms itself.

// --- Body ----------------------------------------------------------------

function requireMaxScore(body) {
    const maxScore = body.max_score;
    if (!Number.isInteger(maxScore) || maxScore < 1) {
        throw badRequest('max_score must be a positive integer');
    }
    return maxScore;
}

/** The mode a new room starts in: the body's, or classic when it doesn't say. */
function modeForNewRoom(body) {
    if (body.game_mode === undefined) {
        return DEFAULT_GAME_MODE;
    }
    return requireGameMode(body.game_mode);
}

// --- Handler -------------------------------------------------------------

export class CreateRoomAction {
    access = 'signed_in';
    allowedStatuses = null;

    constructor({ roomService }) {
        this.roomService = roomService;
    }

    /** Returns { player }: the host's new Player, added to the response. */
    handle(work, body) {
        const request = {
            maxScore: requireMaxScore(body),
            gameMode: modeForNewRoom(body),
            name: normaliseName(body.name),
        };
        return this.roomService.createRoom(work, request);
    }
}
