import { OPEN_STATUSES } from '../../domain/entities.js';
import { requireWins } from './scoreBody.js';

/** set-games-won: the host sets players' games_won (see ScoringService#setGamesWon). */
export class SetGamesWonAction {
    name = 'set-games-won';
    access = 'host';
    allowedStatuses = OPEN_STATUSES;

    constructor({ scoringService }) {
        this.scoringService = scoringService;
    }

    handle(work, body) {
        this.scoringService.setGamesWon(work, requireWins(body));
    }
}
