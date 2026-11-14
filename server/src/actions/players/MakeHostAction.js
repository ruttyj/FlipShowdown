import { OPEN_STATUSES } from '../../domain/entities.js';
import { requirePlayerId } from './requirePlayerId.js';

/** POST make-host: hands the host role to another player. Body { player_id }. */
export class MakeHostAction {
    name = 'make-host';
    access = 'host';
    allowedStatuses = OPEN_STATUSES;

    constructor({ playerService }) {
        this.playerService = playerService;
    }

    handle(work, body) {
        this.playerService.makeHost(work, requirePlayerId(body));
    }
}
