import { requireEditableRound } from '../../services/ScoringService.js';
import { requirePlayerId } from '../requirePlayerId.js';
import { requireRoundNumber, requireScore } from './scoreBody.js';

/** edit-score: the host's correction of any player's score (see ScoringService#editScore). */
export class EditScoreAction {
    name = 'edit-score';
    access = 'host';
    allowedStatuses = ['playing'];

    constructor({ scoringService }) {
        this.scoring = scoringService;
    }

    handle(work, body) {
        // In this order, so a body with several problems gets the error it always has: an unknown
        // player before a bad round, and a round out of range before bad score fields.
        const player = work.getRoomPlayer(requirePlayerId(body));
        const roundNumber = requireRoundNumber(body);
        requireEditableRound(work.room, roundNumber);
        const score = requireScore(body);

        return this.scoring.editScore(work, { player, roundNumber, score, gameMode: body.game_mode });
    }
}
