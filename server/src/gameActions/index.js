import { joinAction, kickAction, leaveAction, makeHostAction, reorderAction } from './players.js';
import { closeAction, deleteAction, setGameModeAction, startAction } from './rooms.js';
import {
    editScoreAction,
    endGameAction,
    forceNextRoundAction,
    playAgainAction,
    reopenGameAction,
    retractScoreAction,
    setEditModeAction,
    setGamesWonAction,
    submitScoreAction,
} from './scoring.js';

// Every action as the old `{ access, allowedStatuses, run(tx, body) }` object, by name, for the root
// test fixture (tests/fixtures/serverRoom.js). Each is an adapter over the same handler class the
// router runs.
export const ACTIONS = {
    join: joinAction,
    leave: leaveAction,
    kick: kickAction,
    'make-host': makeHostAction,
    reorder: reorderAction,
    'set-game-mode': setGameModeAction,
    start: startAction,
    close: closeAction,
    delete: deleteAction,
    'submit-score': submitScoreAction,
    'retract-score': retractScoreAction,
    'force-next-round': forceNextRoundAction,
    'set-edit-mode': setEditModeAction,
    'edit-score': editScoreAction,
    'end-game': endGameAction,
    'reopen-game': reopenGameAction,
    'play-again': playAgainAction,
    'set-games-won': setGamesWonAction,
};
