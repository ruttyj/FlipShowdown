import { EditScoreAction } from './EditScoreAction.js';
import { EndGameAction } from './EndGameAction.js';
import { ForceNextRoundAction } from './ForceNextRoundAction.js';
import { PlayAgainAction } from './PlayAgainAction.js';
import { ReopenGameAction } from './ReopenGameAction.js';
import { RetractScoreAction } from './RetractScoreAction.js';
import { SetEditModeAction } from './SetEditModeAction.js';
import { SetGamesWonAction } from './SetGamesWonAction.js';
import { SubmitScoreAction } from './SubmitScoreAction.js';

/**
 * The scoring and game-flow action handlers, to register in an ActionRegistry under their `name`.
 * `services` holds at least `scoringService`, a ScoringService.
 */
export function createScoringActions(services) {
    return [
        new SubmitScoreAction(services),
        new RetractScoreAction(services),
        new ForceNextRoundAction(services),
        new SetEditModeAction(services),
        new EditScoreAction(services),
        new EndGameAction(services),
        new ReopenGameAction(services),
        new PlayAgainAction(services),
        new SetGamesWonAction(services),
    ];
}
