import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createScoringActions } from '../../../src/actions/scoring/index.js';
import { OPEN_STATUSES } from '../../../src/domain/entities.js';
import { ActionError } from '../../../src/domain/errors.js';

// The scoring handlers: what each declares, and that it parses its body and hands the parsed values
// to one ScoringService method. The service is a stand-in that records its calls; the rules
// themselves are tested in test/services/ScoringService.test.js.

const SCORE_BODY = { cards: [{ value: '5', type: 'number' }], base_sum: 5, final_score: 5 };
const PARSED_SCORE = {
    cards: [{ value: '5', type: 'number' }],
    base_sum: 5,
    final_score: 5,
    busted: false,
    duplicate_allowed: false,
    flip7_attack_player_id: null,
};

/** A ScoringService stand-in: every method records { method, args } and returns `result`. */
function createRecordingService(result) {
    const calls = [];
    const methods = [
        'submitScore',
        'retractScore',
        'forceNextRound',
        'setEditMode',
        'editScore',
        'endGame',
        'reopenGame',
        'playAgain',
        'setGamesWon',
    ];
    const service = { calls };
    for (const method of methods) {
        service[method] = (...args) => {
            calls.push({ method, args });
            return result;
        };
    }
    return service;
}

/** The handlers over a recording service, by name. */
function createHandlers(result) {
    const scoringService = createRecordingService(result);
    const handlers = new Map();
    for (const handler of createScoringActions({ scoringService })) {
        handlers.set(handler.name, handler);
    }
    return { handlers, calls: scoringService.calls };
}

/** Asserts that `action` throws an ActionError with this status and code. */
function assertActionError(action, status, code) {
    assert.throws(action, (error) => {
        assert.ok(error instanceof ActionError, `expected an ActionError, got ${error}`);
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        return true;
    });
}

const WORK = { room: { current_round: 2 } };

describe('scoring action handlers', () => {
    test('declare their name, access and allowed statuses', () => {
        const { handlers } = createHandlers();
        const declared = [...handlers.values()].map((handler) => [handler.name, handler.access, handler.allowedStatuses]);

        assert.deepEqual(declared, [
            ['submit-score', 'member', ['playing']],
            ['retract-score', 'member', ['playing']],
            ['force-next-round', 'host', ['playing']],
            ['set-edit-mode', 'host', ['playing']],
            ['edit-score', 'host', ['playing']],
            ['end-game', 'host', ['playing']],
            ['reopen-game', 'host', ['finished']],
            ['play-again', 'host', ['finished']],
            ['set-games-won', 'host', OPEN_STATUSES],
        ]);
    });

    test('submit-score passes the round, the parsed score and the mode, and returns the result', () => {
        const result = { already_applied: false, round_score: { id: 'score-1' } };
        const { handlers, calls } = createHandlers(result);

        const returned = handlers.get('submit-score').handle(WORK, { round_number: 2, game_mode: 'brutal', ...SCORE_BODY });

        assert.equal(returned, result);
        assert.deepEqual(calls, [
            { method: 'submitScore', args: [WORK, { roundNumber: 2, score: PARSED_SCORE, gameMode: 'brutal' }] },
        ]);
    });

    test('submit-score rejects a bad body before calling the service', () => {
        const { handlers, calls } = createHandlers();

        assertActionError(() => handlers.get('submit-score').handle(WORK, { ...SCORE_BODY }), 400, 'bad_request');
        assertActionError(() => handlers.get('submit-score').handle(WORK, { round_number: 1 }), 400, 'bad_request');
        assert.deepEqual(calls, []);
    });

    test('retract-score and force-next-round pass the round number', () => {
        const result = { already_applied: true, round_score: null };
        const { handlers, calls } = createHandlers(result);

        assert.equal(handlers.get('retract-score').handle(WORK, { round_number: 2 }), result);
        handlers.get('force-next-round').handle(WORK, { round_number: 2 });
        assertActionError(() => handlers.get('force-next-round').handle(WORK, {}), 400, 'bad_request');

        assert.deepEqual(calls, [
            { method: 'retractScore', args: [WORK, 2] },
            { method: 'forceNextRound', args: [WORK, 2] },
        ]);
    });

    test('set-edit-mode passes `on`, which must be a boolean', () => {
        const { handlers, calls } = createHandlers();

        handlers.get('set-edit-mode').handle(WORK, { on: false });
        assertActionError(() => handlers.get('set-edit-mode').handle(WORK, { on: 'off' }), 400, 'bad_request');

        assert.deepEqual(calls, [{ method: 'setEditMode', args: [WORK, false] }]);
    });

    test('end-game, reopen-game and play-again take no body', () => {
        const { handlers, calls } = createHandlers();

        for (const name of ['end-game', 'reopen-game', 'play-again']) {
            assert.equal(handlers.get(name).handle(WORK, {}), undefined);
        }

        assert.deepEqual(calls, [
            { method: 'endGame', args: [WORK] },
            { method: 'reopenGame', args: [WORK] },
            { method: 'playAgain', args: [WORK] },
        ]);
    });

    test('set-games-won passes the checked wins', () => {
        const { handlers, calls } = createHandlers();

        handlers.get('set-games-won').handle(WORK, { wins: { p1: 2 } });
        assertActionError(() => handlers.get('set-games-won').handle(WORK, { wins: { p1: -1 } }), 400, 'bad_request');

        assert.deepEqual(calls, [{ method: 'setGamesWon', args: [WORK, { p1: 2 }] }]);
    });

    describe('edit-score', () => {
        const PLAYER = { id: 'p1' };

        /** A unit of work stand-in on round 2 whose only player is PLAYER. */
        function editWork() {
            return {
                room: { current_round: 2 },
                getRoomPlayer(playerId) {
                    if (playerId !== PLAYER.id) {
                        throw new ActionError(404, 'player_not_found', 'Player not found');
                    }
                    return PLAYER;
                },
            };
        }

        test('passes the looked-up player, the round, the parsed score and the mode', () => {
            const result = { round_score: { id: 'score-1' } };
            const { handlers, calls } = createHandlers(result);
            const work = editWork();

            const returned = handlers.get('edit-score').handle(work, { player_id: 'p1', round_number: 1, ...SCORE_BODY });

            assert.equal(returned, result);
            assert.deepEqual(calls, [
                { method: 'editScore', args: [work, { player: PLAYER, roundNumber: 1, score: PARSED_SCORE, gameMode: undefined }] },
            ]);
        });

        test('checks the body in its old order: player, round, round range, then the score', () => {
            const { handlers, calls } = createHandlers();
            const handle = (body) => handlers.get('edit-score').handle(editWork(), body);

            assertActionError(() => handle({ round_number: 0 }), 400, 'bad_request');
            assertActionError(() => handle({ player_id: 'gone', round_number: 0 }), 404, 'player_not_found');
            assert.throws(() => handle({ player_id: 'p1', round_number: 0 }), /round_number must be a positive integer/);
            assert.throws(() => handle({ player_id: 'p1', round_number: 3 }), /between 1 and the current round/);
            assert.throws(() => handle({ player_id: 'p1', round_number: 2 }), /cards must be an array/);
            assert.deepEqual(calls, []);
        });
    });
});
