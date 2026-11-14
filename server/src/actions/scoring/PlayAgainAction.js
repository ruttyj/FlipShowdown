/** play-again: a new game in the same room with the same players (see ScoringService#playAgain). */
export class PlayAgainAction {
    name = 'play-again';
    access = 'host';
    allowedStatuses = ['finished'];

    constructor({ scoringService }) {
        this.scoringService = scoringService;
    }

    handle(work) {
        this.scoringService.playAgain(work);
    }
}
