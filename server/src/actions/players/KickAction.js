import { OPEN_STATUSES } from '../../domain/entities.js';
import { requirePlayerId } from './requirePlayerId.js';

/** POST kick: removes another player. Body { player_id }. */
export class KickAction {
    name = 'kick';
    access = 'host';
    allowedStatuses = OPEN_STATUSES;

    constructor({ playerService }) {
        this.playerService = playerService;
    }

    handle(work, body) {
        this.playerService.kick(work, requirePlayerId(body));
    }
}
