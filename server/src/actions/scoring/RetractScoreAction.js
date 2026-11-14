import { requireRoundNumber } from './scoreBody.js';

/** retract-score: takes the caller's score for the open round back (see ScoringService#retractScore). */
export class RetractScoreAction {
    name = 'retract-score';
    access = 'member';
    allowedStatuses = ['playing'];

    constructor({ scoringService }) {
        this.scoring = scoringService;
    }

    handle(work, body) {
        return this.scoring.retractScore(work, requireRoundNumber(body));
    }
}
