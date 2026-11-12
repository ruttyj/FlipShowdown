// The rule kernel the client and the server share. Scoring arithmetic is in flip7Scoring.test.js, through
// the client's wrapper; this covers what the server relies on and what the kernel must stay free of.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    DEFAULT_GAME_MODE,
    FLIP7_POINTS,
    GAME_MODE_IDS,
    MAX_CARDS_PER_ROUND,
    isFlip7Hand,
    isKnownGameMode,
    modeCapabilities,
    scoreHand,
} from '../shared/rules.js';

function asNumber(value) {
    return { type: 'number', value: String(value) };
}

function asSpecial(value) {
    return { type: 'special', value };
}

// --- The kernel can run anywhere ----------------------------------------------

test('the kernel imports nothing, so the client and the server can both load it', () => {
    const source = fs.readFileSync(new URL('../shared/rules.js', import.meta.url), 'utf8');

    assert.doesNotMatch(source, /^\s*(import|export .* from)\b.*['"]/m);
    assert.doesNotMatch(source, /\b(window|document|localStorage|process)\./);
});

// --- Facts --------------------------------------------------------------------

test('the facts both sides depend on', () => {
    assert.equal(FLIP7_POINTS, 15);
    assert.equal(MAX_CARDS_PER_ROUND, 30);
});

// --- Mode capabilities --------------------------------------------------------

test('the modes are offered in order, starting from the default', () => {
    assert.deepEqual([...GAME_MODE_IDS], ['classic', 'vengeance', 'brutal']);
    assert.equal(DEFAULT_GAME_MODE, 'classic');
});

test('only a real mode id is known', () => {
    assert.equal(isKnownGameMode('brutal'), true);
    for (const mode of [undefined, null, '', 'not-a-mode', 'constructor', 7]) {
        assert.equal(isKnownGameMode(mode), false, String(mode));
    }
});

test('a missing or unknown mode has classic\'s capabilities', () => {
    for (const mode of [undefined, null, 'not-a-mode', 'constructor']) {
        assert.equal(modeCapabilities(mode).id, 'classic', String(mode));
    }
});

test('only Brutal can attack, and the server refuses an attack anywhere else', () => {
    const attackModes = GAME_MODE_IDS.filter((mode) => modeCapabilities(mode).hasFlip7Attack);

    assert.deepEqual(attackModes, ['brutal']);
});

// --- What a Flip 7 is ---------------------------------------------------------

const SEVEN_NUMBERS = [1, 2, 3, 4, 5, 6, 7].map(asNumber);
const SIX_NUMBERS = [1, 2, 3, 4, 5, 6].map(asNumber);

const FLIP_7_HANDS = [
    ['seven numbers', SEVEN_NUMBERS, {}, true],
    ['six numbers', SIX_NUMBERS, {}, false],
    ['eight numbers', [1, 2, 3, 4, 5, 6, 7, 8].map(asNumber), {}, false],
    ['seven rows with a blank', [1, 2, 3, 4, 5, 6, ''].map(asNumber), {}, false],
    ['six numbers and a whitespace row', [1, 2, 3, 4, 5, 6, ' '].map(asNumber), {}, false],
    ['The Zero and six numbers', [asSpecial('0'), ...SIX_NUMBERS], {}, true],
    ['a value that reads as 0', ['abc', 1, 2, 3, 4, 5, 6].map(asNumber), {}, true],
    ['seven numbers and modifiers', [...SEVEN_NUMBERS, { type: 'subtractor', value: '4' }, { type: 'divisor', value: '2' }], {}, true],
    ['Lucky 13 and a 13', [asSpecial('13'), ...[13, 1, 2, 3, 4, 5].map(asNumber)], {}, true],
    ['Unlucky 7 and six others', [asSpecial('7'), ...SIX_NUMBERS], {}, true],
    ['a vouched duplicate', [1, 2, 3, 4, 5, 6, 6].map(asNumber), { duplicateAllowed: true }, false],
    ['a vouched third 13 with Lucky', [asSpecial('13'), ...[13, 13, 1, 2, 3, 4, 5].map(asNumber)], { duplicateAllowed: true }, true],
    ['seven different with a vouched duplicate on top', [1, 2, 3, 4, 5, 6, 7, 7].map(asNumber), { duplicateAllowed: true }, true],
    ['seven different with a repeat nobody vouched for', [1, 1, 2, 3, 4, 5, 6, 7].map(asNumber), {}, false],
    ['a third 13 with Lucky nobody vouched for', [asSpecial('13'), ...[13, 13, 1, 2, 3, 4, 5].map(asNumber)], {}, false],
    ['a repeated 13 with no Lucky', [13, 13, 1, 2, 3, 4, 5, 6].map(asNumber), {}, false],
    ['Lucky 13, its 13 and a repeat nobody vouched for', [asSpecial('13'), ...[13, 1, 1, 2, 3, 4, 5].map(asNumber)], {}, false],
];

for (const [description, cards, options, expected] of FLIP_7_HANDS) {
    // The score and the attack check have to agree, or a player could be offered an attack that's refused.
    test(`a Flip 7 is judged the same when scoring and when attacking: ${description}`, () => {
        assert.equal(isFlip7Hand(cards, options), expected);
        assert.equal(scoreHand(cards, 'brutal', options).bonus > 0, expected);
    });
}

test('isFlip7Hand needs no options', () => {
    assert.equal(isFlip7Hand(SEVEN_NUMBERS), true);
});

// --- Scoring under a mode -----------------------------------------------------

test('scoreHand gives each mode its own rules', () => {
    const hand = [asNumber(5), { type: 'subtractor', value: '10' }];

    assert.equal(scoreHand(hand, 'vengeance').finalScore, 0);
    assert.equal(scoreHand(hand, 'brutal').finalScore, -5);
    assert.equal(scoreHand([asNumber(5), asNumber(5)], 'not-a-mode').isDuplicateBust, true);
});

test('only a mode with attacks can give up a Flip 7\'s bonus', () => {
    const attack = { flip7Attack: true };

    assert.equal(scoreHand(SEVEN_NUMBERS, 'brutal', attack).bonus, 0);
    assert.equal(scoreHand(SEVEN_NUMBERS, 'vengeance', attack).bonus, FLIP7_POINTS);
    assert.equal(scoreHand(SEVEN_NUMBERS, 'classic', attack).bonus, FLIP7_POINTS);
});
