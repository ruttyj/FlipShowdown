import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createScoringActions } from '../../../src/actions/scoring/index.js';
import * as legacy from '../../../src/gameActions/scoring.js';

// gameActions/scoring.js keeps the old { access, allowedStatuses, run } objects for ACTIONS, which
// the root test fixture runs. Each must match its handler and run it.

const EXPORT_NAMES = {
    'submit-score': 'submitScoreAction',
    'retract-score': 'retractScoreAction',
    'force-next-round': 'forceNextRoundAction',
    'set-edit-mode': 'setEditModeAction',
    'edit-score': 'editScoreAction',
    'end-game': 'endGameAction',
    'reopen-game': 'reopenGameAction',
    'play-again': 'playAgainAction',
    'set-games-won': 'setGamesWonAction',
};

describe('gameActions/scoring.js adapters', () => {
    test('each has its handler\'s access and allowed statuses', () => {
        for (const handler of createScoringActions({ scoringService: null })) {
            const action = legacy[EXPORT_NAMES[handler.name]];

            assert.equal(action.access, handler.access, handler.name);
            assert.deepEqual(action.allowedStatuses, handler.allowedStatuses, handler.name);
        }
    });

    test('run passes the unit of work and body to the handler', () => {
        // A bad body fails in the handler's parsing, before anything touches the unit of work.
        assert.throws(() => legacy.submitScoreAction.run({}, {}), /round_number must be a positive integer/);
    });
});
