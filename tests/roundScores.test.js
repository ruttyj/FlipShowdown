// Tests for the RoundScore lookups. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attackLabels, attackToast, describeBust, displayScore, findStoredScore, spokenScore } from '../src/lib/roundScores.js';

function makeScore(playerId, roundNumber, finalScore) {
    return { id: `${playerId}-${roundNumber}`, player_id: playerId, round_number: roundNumber, final_score: finalScore };
}

const SCORES = [
    makeScore('p1', 1, 10),
    makeScore('p2', 1, 20),
    makeScore('p1', 2, 30),
];

// --- findStoredScore ----------------------------------------------------------

test('finds the score saved for that player and round', () => {
    assert.equal(findStoredScore(SCORES, 'p1', 2), SCORES[2]);
    assert.equal(findStoredScore(SCORES, 'p2', 1), SCORES[1]);
});

test('is null when the player has no score for that round', () => {
    assert.equal(findStoredScore(SCORES, 'p2', 2), null);
    assert.equal(findStoredScore(SCORES, 'p3', 1), null);
    assert.equal(findStoredScore([], 'p1', 1), null);
});

test('a BUST cell is named with who busted and the score', () => {
    assert.equal(describeBust('Sam', { final_score: 0 }), 'Sam busted, 0 points');
    assert.equal(describeBust('Sam', { final_score: -6 }), 'Sam busted, minus 6 points');
});

test('a score shows a real minus sign, and leaves other scores alone', () => {
    assert.equal(displayScore(-6), '−6');
    assert.equal(displayScore(0), '0');
    assert.equal(displayScore(12), '12');
});

test('a score says "minus" out loud', () => {
    assert.equal(spokenScore(-6), 'minus 6');
    assert.equal(spokenScore(0), '0');
    assert.equal(spokenScore(12), '12');
});

// --- The Flip 7 attack (X43) -----------------------------------------------------------

const ATTACK_PLAYERS = [{ id: 'ann', name: 'Ann' }, { id: 'sam', name: 'Sam' }];

test('attackLabels names who took 15 from a player in a round', () => {
    const scores = [
        { id: 's1', player_id: 'ann', round_number: 1, flip7_attack_player_id: 'sam' },
        { id: 's2', player_id: 'sam', round_number: 1 },
        { id: 's3', player_id: 'ann', round_number: 2, flip7_attack_player_id: 'sam' },
    ];

    assert.deepEqual(attackLabels(scores, ATTACK_PLAYERS, 'sam', 1), [{ id: 's1', text: '−15 from\u00a0Ann' }]);
    assert.deepEqual(attackLabels(scores, ATTACK_PLAYERS, 'ann', 1), []);
    assert.deepEqual(attackLabels(scores, ATTACK_PLAYERS, 'sam', 3), []);
});

test('attackLabels lists every attack, and a player who has gone is Someone', () => {
    const scores = [
        { id: 's1', player_id: 'ann', round_number: 1, flip7_attack_player_id: 'sam' },
        { id: 's2', player_id: 'gone', round_number: 1, flip7_attack_player_id: 'sam' },
    ];

    assert.deepEqual(attackLabels(scores, ATTACK_PLAYERS, 'sam', 1), [
        { id: 's1', text: '−15 from\u00a0Ann' },
        { id: 's2', text: '−15 from\u00a0Someone' },
    ]);
});

test('attackToast says who took 15', () => {
    assert.equal(attackToast(ATTACK_PLAYERS, 'ann'), 'Ann flipped 7 and took 15 points from you');
    assert.equal(attackToast(ATTACK_PLAYERS, 'gone'), 'Someone flipped 7 and took 15 points from you');
});
