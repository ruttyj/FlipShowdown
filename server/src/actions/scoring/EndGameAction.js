/** end-game: finishes the game without adding a win (see ScoringService#endGame). */
export class EndGameAction {
    name = 'end-game';
    access = 'host';
    allowedStatuses = ['playing'];

    constructor({ scoringService }) {
        this.scoring = scoringService;
    }

    handle(work) {
        this.scoring.endGame(work);
    }
}
