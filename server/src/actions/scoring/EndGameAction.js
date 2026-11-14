/** end-game: finishes the game without adding a win (see ScoringService#endGame). */
export class EndGameAction {
    name = 'end-game';
    access = 'host';
    allowedStatuses = ['playing'];

    constructor({ scoringService }) {
        this.scoringService = scoringService;
    }

    handle(work) {
        this.scoringService.endGame(work);
    }
}
