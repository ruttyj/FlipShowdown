import { requireRoundNumber } from './scoreBody.js';

/** force-next-round: a 0 for whoever hasn't scored, then the round advances (see ScoringService#forceNextRound). */
export class ForceNextRoundAction {
    name = 'force-next-round';
    access = 'host';
    allowedStatuses = ['playing'];

    constructor({ scoringService }) {
        this.scoringService = scoringService;
    }

    handle(work, body) {
        this.scoringService.forceNextRound(work, requireRoundNumber(body));
    }
}
