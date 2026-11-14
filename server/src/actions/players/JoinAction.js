import { OPEN_STATUSES } from '../../domain/entities.js';
import { normaliseName } from '../../services/auth.js';

/** POST join: seats the caller in the room. Body { name }. Returns { player, already_joined }. */
export class JoinAction {
    name = 'join';
    access = 'signed_in';
    allowedStatuses = OPEN_STATUSES;

    constructor({ playerService }) {
        this.playerService = playerService;
    }

    handle(work, body) {
        // An invalid name becomes null; PlayerService rejects it only for a caller not yet seated.
        const name = normaliseName(body.name);
        return this.playerService.join(work, name);
    }
}
