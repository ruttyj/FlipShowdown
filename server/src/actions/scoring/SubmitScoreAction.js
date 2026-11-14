import { requireRoundNumber, requireScore } from './scoreBody.js';

/** submit-score: the caller's score for a round (see ScoringService#submitScore). */
export class SubmitScoreAction {
    name = 'submit-score';
    access = 'member';
    allowedStatuses = ['playing'];

    constructor({ scoringService }) {
        this.scoring = scoringService;
    }

    handle(work, body) {
        const request = {
            roundNumber: requireRoundNumber(body),
            score: requireScore(body),
            gameMode: body.game_mode,
        };
        return this.scoring.submitScore(work, request);
    }
}
