import { requireRoundNumber } from './scoreBody.js';

/** retract-score: takes the caller's score for the open round back (see ScoringService#retractScore). */
export class RetractScoreAction {
    name = 'retract-score';
    access = 'member';
    allowedStatuses = ['playing'];

    constructor({ scoringService }) {
        this.scoringService = scoringService;
    }

    handle(work, body) {
        return this.scoringService.retractScore(work, requireRoundNumber(body));
    }
}
