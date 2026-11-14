import { badRequest } from '../../domain/errors.js';

/** True when `value` is an array of strings. */
function isListOfIds(value) {
    return Array.isArray(value) && value.every((id) => typeof id === 'string');
}

/** POST reorder: sets the turn order before the game starts. Body { player_ids }. */
export class ReorderAction {
    name = 'reorder';
    access = 'host';
    allowedStatuses = ['waiting'];

    constructor({ playerService }) {
        this.playerService = playerService;
    }

    handle(work, body) {
        const playerIds = body.player_ids;
        if (!isListOfIds(playerIds)) {
            // Same message as PlayerService#reorder's check that the list names every player once.
            throw badRequest('player_ids must list every player in the room exactly once');
        }

        this.playerService.reorder(work, playerIds);
    }
}
