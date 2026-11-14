import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { requirePlayerId } from '../../../src/actions/requirePlayerId.js';
import {
    requireBoolean,
    requireRoundNumber,
    requireScore,
    requireWins,
} from '../../../src/actions/scoring/scoreBody.js';
import { ActionError } from '../../../src/domain/errors.js';

// The scoring handlers' body parsing, plus requirePlayerId, which they share with the player
// handlers.

/** Asserts that `action` throws a 400 bad_request whose message matches `pattern`. */
function assertBadRequest(action, pattern) {
    assert.throws(action, (error) => {
        assert.ok(error instanceof ActionError, `expected an ActionError, got ${error}`);
        assert.equal(error.status, 400);
        assert.equal(error.code, 'bad_request');
        assert.match(error.message, pattern);
        return true;
    });
}

const SCORE_BODY = { cards: [{ value: '5', type: 'number' }], base_sum: 5, final_score: 5 };

describe('scoreBody', () => {
    test('requireBoolean takes only a boolean', () => {
        assert.equal(requireBoolean({ on: true }, 'on'), true);
        assert.equal(requireBoolean({ on: false }, 'on'), false);

        for (const on of [undefined, 'true', 1, null]) {
            assertBadRequest(() => requireBoolean({ on }, 'on'), /on must be a boolean/);
        }
    });

    test('requireRoundNumber takes a positive integer', () => {
        assert.equal(requireRoundNumber({ round_number: 3 }), 3);

        for (const roundNumber of [undefined, 0, -1, 1.5, '2']) {
            assertBadRequest(() => requireRoundNumber({ round_number: roundNumber }), /round_number/);
        }
    });

    test('requirePlayerId takes a non-empty string', () => {
        assert.equal(requirePlayerId({ player_id: 'p1' }), 'p1');

        for (const playerId of [undefined, '', 7, null]) {
            assertBadRequest(() => requirePlayerId({ player_id: playerId }), /player_id/);
        }
    });

    test('requireWins takes an object of integers of 0 or more', () => {
        assert.deepEqual(requireWins({ wins: { a: 0, b: 4 } }), { a: 0, b: 4 });

        for (const wins of [undefined, null, [], 'a']) {
            assertBadRequest(() => requireWins({ wins }), /wins must be an object/);
        }
        for (const value of [-1, 1.5, '2', null]) {
            assertBadRequest(() => requireWins({ wins: { a: value } }), /each wins value/);
        }
    });

    describe('requireScore', () => {
        test('fills the optional fields with their defaults and drops extra card fields', () => {
            const body = { ...SCORE_BODY, cards: [{ value: '5', type: 'number', extra: 'dropped' }] };

            assert.deepEqual(requireScore(body), {
                cards: [{ value: '5', type: 'number' }],
                base_sum: 5,
                final_score: 5,
                busted: false,
                duplicate_allowed: false,
                flip7_attack_player_id: null,
            });
        });

        test('keeps the optional fields when they are given', () => {
            const body = { ...SCORE_BODY, busted: true, duplicate_allowed: true, flip7_attack_player_id: 'p2' };

            const score = requireScore(body);

            assert.equal(score.busted, true);
            assert.equal(score.duplicate_allowed, true);
            assert.equal(score.flip7_attack_player_id, 'p2');
            assert.equal(requireScore({ ...SCORE_BODY, flip7_attack_player_id: null }).flip7_attack_player_id, null);
        });

        test('cards must be an array of at most 30 {value, type} strings', () => {
            const tooMany = Array.from({ length: 31 }, () => ({ value: '1', type: 'number' }));
            const badCards = [undefined, 'cards', tooMany, [null], [{ value: 5, type: 'number' }], [{ value: '5' }]];

            for (const cards of badCards) {
                assertBadRequest(() => requireScore({ ...SCORE_BODY, cards }), /cards must be an array of at most 30/);
            }
        });

        test('base_sum and final_score must be integers from -1000 to 1000', () => {
            assert.equal(requireScore({ ...SCORE_BODY, base_sum: -1000, final_score: 1000 }).final_score, 1000);

            for (const value of [undefined, 1001, -1001, 2.5, '5']) {
                assertBadRequest(() => requireScore({ ...SCORE_BODY, base_sum: value }), /base_sum and final_score/);
                assertBadRequest(() => requireScore({ ...SCORE_BODY, final_score: value }), /base_sum and final_score/);
            }
        });

        test('the flags must be booleans and the attack target a non-empty string or null', () => {
            assertBadRequest(() => requireScore({ ...SCORE_BODY, busted: 'yes' }), /busted must be a boolean/);
            assertBadRequest(() => requireScore({ ...SCORE_BODY, duplicate_allowed: 1 }), /duplicate_allowed must be a boolean/);
            for (const target of ['', 4]) {
                assertBadRequest(() => requireScore({ ...SCORE_BODY, flip7_attack_player_id: target }), /flip7_attack_player_id/);
            }
        });
    });
});
