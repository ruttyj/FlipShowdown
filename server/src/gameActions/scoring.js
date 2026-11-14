import { createScoringActions } from '../actions/scoring/index.js';
import { RoundService } from '../services/RoundService.js';
import { ScoringService } from '../services/ScoringService.js';
import { TotalsService } from '../services/TotalsService.js';

// The old { access, allowedStatuses, run(tx, body) } objects over the scoring action handlers, for
// ACTIONS in index.js, which the root test fixture runs through runRoomAction. The router runs the
// handlers themselves. Removed in P3.3.

function createLegacyActions() {
    const totalsService = new TotalsService();
    const roundService = new RoundService();
    const scoringService = new ScoringService({ roundService, totalsService });

    const actions = new Map();
    for (const handler of createScoringActions({ scoringService })) {
        actions.set(handler.name, {
            access: handler.access,
            allowedStatuses: handler.allowedStatuses,
            run: (tx, body) => handler.handle(tx, body),
        });
    }
    return actions;
}

const LEGACY_ACTIONS = createLegacyActions();

export const submitScoreAction = LEGACY_ACTIONS.get('submit-score');
export const retractScoreAction = LEGACY_ACTIONS.get('retract-score');
export const forceNextRoundAction = LEGACY_ACTIONS.get('force-next-round');
export const setEditModeAction = LEGACY_ACTIONS.get('set-edit-mode');
export const editScoreAction = LEGACY_ACTIONS.get('edit-score');
export const endGameAction = LEGACY_ACTIONS.get('end-game');
export const reopenGameAction = LEGACY_ACTIONS.get('reopen-game');
export const playAgainAction = LEGACY_ACTIONS.get('play-again');
export const setGamesWonAction = LEGACY_ACTIONS.get('set-games-won');
