/** reopen-game: undoes a finish so the host can fix the last score (see ScoringService#reopenGame). */
export class ReopenGameAction {
    name = 'reopen-game';
    access = 'host';
    allowedStatuses = ['finished'];

    constructor({ scoringService }) {
        this.scoring = scoringService;
    }

    handle(work) {
        this.scoring.reopenGame(work);
    }
}
