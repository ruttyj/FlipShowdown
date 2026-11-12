// Tests for round scoring. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARD_TYPES, calculateFlip7Score, describeScoreBreakdown } from '../src/lib/flip7Scoring.js';
import { scoreVengeance } from '../src/lib/handScoring.js';

// --- Fixtures ----------------------------------------------------------------

function numbers(...values) {
    return values.map((value) => ({ type: 'number', value: String(value) }));
}

function card(type, value) {
    return { type, value };
}

function finalScore(cards) {
    return calculateFlip7Score(cards).finalScore;
}

// --- Number cards and busts --------------------------------------------------

test('no cards scores 0 with no bonus and no bust', () => {
    assert.deepEqual(calculateFlip7Score([]), {
        baseSum: 0,
        multiplier: 1,
        adder: 0,
        bonus: 0,
        finalScore: 0,
        isDuplicateBust: false,
        isBust: false,
        zeroed: false,
        flooredAtZero: false,
        warnings: [],
    });
});

test('number cards sum into baseSum', () => {
    const score = calculateFlip7Score(numbers(3, 5, 10));

    assert.equal(score.baseSum, 18);
    assert.equal(score.finalScore, 18);
});

test('a 0 number card counts toward the 7-card bonus', () => {
    const score = calculateFlip7Score(numbers(0, 1, 2, 3, 4, 5, 6));

    assert.equal(score.bonus, 15);
    assert.equal(score.finalScore, 36);
});

test('two equal number cards bust, even with modifiers', () => {
    const cards = [...numbers(4, 4), card('multiplier', 'x2'), card('adder', '+4')];

    assert.deepEqual(calculateFlip7Score(cards), {
        baseSum: 0,
        multiplier: 1,
        adder: 0,
        bonus: 0,
        finalScore: 0,
        isDuplicateBust: true,
        isBust: true,
        zeroed: false,
        flooredAtZero: false,
        warnings: [],
    });
});

test('exactly 7 distinct number cards add the 15 bonus and 6 do not', () => {
    assert.equal(calculateFlip7Score(numbers(1, 2, 3, 4, 5, 6, 7)).bonus, 15);
    assert.equal(calculateFlip7Score(numbers(1, 2, 3, 4, 5, 6)).bonus, 0);
});

test('8 number cards cannot happen without a duplicate, so they bust', () => {
    const score = calculateFlip7Score(numbers(1, 2, 3, 4, 5, 6, 7, 7));

    assert.equal(score.isDuplicateBust, true);
    assert.equal(score.finalScore, 0);
});

// --- Modifiers ---------------------------------------------------------------

test('x2 doubles baseSum and two x2 cards multiply to x4', () => {
    assert.equal(finalScore([...numbers(5), card('multiplier', 'x2')]), 10);

    const score = calculateFlip7Score([...numbers(5), card('multiplier', 'x2'), card('multiplier', 'x2')]);
    assert.equal(score.multiplier, 4);
    assert.equal(score.finalScore, 20);
});

test('÷2 halves and the final score rounds down', () => {
    assert.equal(finalScore([...numbers(7), card('divisor', '÷2')]), 3);
});

test('a multiplier and a divisor cancel out', () => {
    const score = calculateFlip7Score([...numbers(9), card('multiplier', 'x2'), card('divisor', '÷2')]);

    assert.equal(score.multiplier, 1);
    assert.equal(score.finalScore, 9);
});

test('adders apply after multiplying', () => {
    const cards = [...numbers(5, 3), card('multiplier', 'x2'), card('adder', '+4')];

    assert.equal(finalScore(cards), 20);
});

test('subtractors from -2 to -10 subtract', () => {
    for (let amount = 2; amount <= 10; amount++) {
        const cards = [...numbers(12), card('subtractor', `-${amount}`)];

        assert.equal(finalScore(cards), 12 - amount);
    }
});

test('a hand that goes below 0 keeps its negative score (X1)', () => {
    const score = calculateFlip7Score([...numbers(2), card('subtractor', '-4')]);

    assert.equal(score.adder, -4);
    assert.equal(score.finalScore, -2);
});

test('a number card typed as -3 counts as -3 (X1)', () => {
    const alone = calculateFlip7Score(numbers(-3));

    assert.equal(alone.baseSum, -3);
    assert.equal(alone.finalScore, -3);
    assert.equal(calculateFlip7Score(numbers(-3, 5)).baseSum, 2);
});

test('÷2 on an odd negative total rounds down (X1)', () => {
    assert.equal(finalScore([...numbers(-7), card('divisor', '÷2')]), -4);
});

test('the 7-card bonus is not multiplied', () => {
    const cards = [...numbers(1, 2, 3, 4, 5, 6, 7), card('multiplier', 'x2')];

    assert.equal(finalScore(cards), 28 * 2 + 15);
});

test('modifier values with no digits or 0 fall back', () => {
    assert.equal(finalScore([...numbers(5), card('multiplier', 'x')]), 10);
    assert.equal(finalScore([...numbers(5), card('multiplier', 'x0')]), 10);
    assert.equal(finalScore([...numbers(8), card('divisor', '÷')]), 4);
    assert.equal(finalScore([...numbers(8), card('divisor', '÷0')]), 4);
    assert.equal(finalScore([...numbers(8), card('subtractor', '-')]), 8);
    assert.equal(finalScore([...numbers(8), card('subtractor', '0')]), 8);
});

// The card type carries the sign, so a stray sign in the value is ignored.
test('modifiers score by their type, ignoring any sign in the value (X34)', () => {
    assert.equal(finalScore([...numbers(10), card('adder', '-4')]), 14);
    assert.equal(finalScore([...numbers(10), card('adder', '4')]), 14);
    assert.equal(finalScore([...numbers(10), card('subtractor', '4')]), 6);
    assert.equal(finalScore([...numbers(10), card('subtractor', '+4')]), 6);
    assert.equal(finalScore([...numbers(5), card('multiplier', '2')]), 10);
    assert.equal(finalScore([...numbers(8), card('divisor', '2')]), 4);
});

test('missing or null values never throw', () => {
    const cards = [
        { type: 'number' },
        { type: 'number', value: null },
        { type: 'multiplier' },
        { type: 'divisor', value: null },
        { type: 'adder' },
        { type: 'subtractor', value: null },
    ];

    assert.doesNotThrow(() => calculateFlip7Score(cards));
});

test('unknown card types are ignored', () => {
    assert.equal(finalScore([...numbers(5), card('wild', '99')]), 5);
});

test('non-numeric number values count as 0', () => {
    const score = calculateFlip7Score(numbers('abc', 4));

    assert.equal(score.baseSum, 4);
    assert.equal(score.isDuplicateBust, false);
});

// --- Blank rows and odd numbers (X2) -----------------------------------------

test('a blank number row is ignored, not a 0', () => {
    const blanks = [card('number', ''), card('number', '   '), card('number', null), { type: 'number' }];
    const score = calculateFlip7Score([...numbers(5), ...blanks]);

    assert.equal(score.baseSum, 5);
    assert.equal(score.isDuplicateBust, false);
});

test('a blank row plus a real 0 does not bust', () => {
    const score = calculateFlip7Score([card('number', ''), ...numbers(0)]);

    assert.equal(score.isDuplicateBust, false);
});

test('two blank rows do not bust', () => {
    const score = calculateFlip7Score([card('number', ''), card('number', ' ')]);

    assert.equal(score.isDuplicateBust, false);
    assert.equal(score.finalScore, 0);
});

test('six cards plus a blank row get no 7-card bonus', () => {
    const score = calculateFlip7Score([...numbers(1, 2, 3, 4, 5, 6), card('number', '')]);

    assert.equal(score.bonus, 0);
});

test('"3.5" parses to 3 and busts with "3"', () => {
    assert.equal(calculateFlip7Score(numbers('3.5', '3')).isDuplicateBust, true);
});

test('"99" is accepted with no range check', () => {
    assert.equal(finalScore(numbers(99)), 99);
});

// --- describeScoreBreakdown --------------------------------------------------

test('only number cards describes as "Total:"', () => {
    assert.equal(describeScoreBreakdown(calculateFlip7Score(numbers(3, 4))), 'Total:');
});

test('the breakdown lists ×, +, − and the bonus in order, ending with =', () => {
    const multiplied = { baseSum: 12, multiplier: 2, adder: 4, bonus: 15 };
    const subtracted = { baseSum: 12, multiplier: 1, adder: -4, bonus: 15 };

    assert.equal(describeScoreBreakdown(multiplied), '12 × 2 + 4 + 15 =');
    assert.equal(describeScoreBreakdown(subtracted), '12 − 4 + 15 =');
});

test('the breakdown shows ÷ with the divisor', () => {
    assert.equal(describeScoreBreakdown({ baseSum: 12, multiplier: 0.25, adder: -4, bonus: 0 }), '12 ÷ 4 − 4 =');
});

// --- Game modes: the scoring table ---------------------------------------

function special(value) {
    return card('special', value);
}

function minus(amount) {
    return card('subtractor', String(amount));
}

const HALF = card('divisor', '2');
const ZERO = special('0');
const UNLUCKY_7 = special('7');
const LUCKY_13 = special('13');
const SEVEN_SUMMING_48 = numbers(1, 3, 5, 7, 9, 11, 12);
const SEVEN_SUMMING_28 = numbers(1, 2, 3, 4, 5, 6, 7);
const SIX_SUMMING_62 = numbers(13, 12, 11, 10, 9, 7);
const SIX_SUMMING_40 = numbers(1, 3, 5, 8, 11, 12);

const SCORING_TABLE = [
    ['the rulebook example', [...SEVEN_SUMMING_48, HALF, minus(4)], 'vengeance', 35],
    ['six numbers get no bonus', [...SIX_SUMMING_62, HALF, minus(4)], 'vengeance', 27],
    ['÷2 rounds down', [...numbers(5), HALF], 'vengeance', 2],
    ['the score stops at 0', [...numbers(5), minus(10)], 'vengeance', 0],
    ['the floor comes before the bonus', [...SEVEN_SUMMING_28, HALF, minus(10), minus(8), minus(6)], 'vengeance', 15],
    ['The Zero wipes the hand', [ZERO, ...numbers(12, 11), minus(2)], 'vengeance', 0],
    ['The Zero counts toward the seven', [ZERO, ...SIX_SUMMING_40], 'vengeance', 55],
    ['Lucky 13 lets a second 13 score', [LUCKY_13, ...numbers(13)], 'vengeance', 26],
    ['Lucky 13 and its 13 are both in the seven', [LUCKY_13, ...numbers(13, 1, 2, 3, 4, 5)], 'vengeance', 56],
    ['Unlucky 7 is worth 7', [UNLUCKY_7], 'vengeance', 7],
    ['cards after Unlucky 7 score', [UNLUCKY_7, ...numbers(5), minus(2)], 'vengeance', 10],
    ['classic counts specials as numbers', [UNLUCKY_7, LUCKY_13], 'classic', 20],
    ['classic x2 and +N are unchanged', [...numbers(10), card('multiplier', '2'), card('adder', '4')], 'classic', 24],
    ['the X25 example is unchanged', [...numbers(13), HALF, minus(6)], 'classic', 0],
    ['the X1 negative is unchanged', [...numbers(5), minus(10)], 'classic', -5],
];

for (const [name, cards, mode, expected] of SCORING_TABLE) {
    test(`${mode}: ${name} (${expected})`, () => {
        const score = calculateFlip7Score(cards, mode);

        assert.equal(score.finalScore, expected);
        assert.equal(score.isBust, false);
    });
}

const BUST_TABLE = [
    ['a third 13 busts despite Lucky 13', [LUCKY_13, ...numbers(13, 13)]],
    ['two plain 13s bust', numbers(13, 13)],
    ['a plain 7 with Unlucky 7 busts', [UNLUCKY_7, ...numbers(7)]],
];

for (const [name, cards] of BUST_TABLE) {
    test(`vengeance: ${name}`, () => {
        const score = calculateFlip7Score(cards, 'vengeance');

        assert.equal(score.isBust, true);
        assert.equal(score.isDuplicateBust, true);
        assert.equal(score.finalScore, 0);
    });
}

test('vengeance: eight numbers score their sum with no bonus and a warning', () => {
    const score = calculateFlip7Score(numbers(1, 2, 3, 4, 5, 6, 8, 9), 'vengeance');

    assert.equal(score.finalScore, 38);
    assert.equal(score.bonus, 0);
    assert.deepEqual(score.warnings, ['More than 7 number cards, so no bonus. Check your cards.']);
});

test('vengeance: a declared bust keeps its cards out of the score', () => {
    const score = calculateFlip7Score(numbers(5, 9), 'vengeance', { busted: true });

    assert.equal(score.isBust, true);
    assert.equal(score.isDuplicateBust, false);
    assert.equal(score.finalScore, 0);
});

test('vengeance: a declared bust with a minus card still scores 0', () => {
    const score = calculateFlip7Score([...numbers(5), minus(6)], 'vengeance', { busted: true });

    assert.equal(score.finalScore, 0);
});

test('classic: a declared bust scores 0 with or without cards', () => {
    const withCards = calculateFlip7Score(numbers(5, 9), 'classic', { busted: true });
    const noCards = calculateFlip7Score([], 'classic', { busted: true });

    assert.equal(withCards.isBust, true);
    assert.equal(withCards.isDuplicateBust, false);
    assert.equal(withCards.finalScore, 0);
    assert.equal(noCards.isBust, true);
    assert.equal(noCards.finalScore, 0);
});

test('vengeance: the Steal or Swap override scores both cards', () => {
    const score = calculateFlip7Score(numbers(5, 5), 'vengeance', { duplicateAllowed: true });

    assert.equal(score.isBust, false);
    assert.equal(score.finalScore, 10);
});

test('vengeance: an overridden duplicate does not count toward the seven', () => {
    const score = calculateFlip7Score(numbers(1, 2, 3, 4, 5, 6, 6), 'vengeance', { duplicateAllowed: true });

    assert.equal(score.bonus, 0);
    assert.equal(score.finalScore, 27);
});

test('classic has no Steal or Swap, so it has no override: a duplicate always busts (§3.14)', () => {
    const score = calculateFlip7Score(numbers(5, 5), 'classic', { duplicateAllowed: true });

    assert.equal(score.isDuplicateBust, true);
    assert.equal(score.finalScore, 0);
});

test('a missing or unknown mode scores as classic', () => {
    const hand = [...numbers(5), minus(10)];

    assert.equal(calculateFlip7Score(hand).finalScore, -5);
    assert.equal(calculateFlip7Score(hand, undefined).finalScore, -5);
    assert.equal(calculateFlip7Score(hand, 'not-a-mode').finalScore, -5);
});

test('vengeance: The Zero with no Flip 7 reports zeroed and keeps the working', () => {
    const score = calculateFlip7Score([ZERO, ...numbers(12, 11)], 'vengeance');

    assert.equal(score.zeroed, true);
    assert.equal(score.baseSum, 23);
    assert.equal(score.finalScore, 0);
});

test('vengeance: a stored number 0 is The Zero, since the deck has no other 0', () => {
    const score = calculateFlip7Score(numbers(0, 12), 'vengeance');

    assert.equal(score.zeroed, true);
    assert.equal(score.finalScore, 0);
});

test('vengeance: a number value that is not a number is not The Zero', () => {
    const score = calculateFlip7Score(numbers('abc', 12), 'vengeance');

    assert.equal(score.zeroed, false);
    assert.equal(score.finalScore, 12);
});

test('vengeance: flooredAtZero is set only when the floor changed the score', () => {
    assert.equal(calculateFlip7Score([...numbers(5), minus(10)], 'vengeance').flooredAtZero, true);
    assert.equal(calculateFlip7Score([...numbers(5), minus(5)], 'vengeance').flooredAtZero, false);
});

test('vengeance: cards from another mode still score, never rejected', () => {
    const hand = [...numbers(5), card('multiplier', '2'), card('adder', '4')];

    assert.equal(calculateFlip7Score(hand, 'vengeance').finalScore, 14);
});

test('vengeance: blank number and special rows are ignored', () => {
    const score = calculateFlip7Score([...numbers(5), card('number', ''), special('')], 'vengeance');

    assert.equal(score.finalScore, 5);
    assert.equal(score.zeroed, false);
});

test('classic: a blank special row is ignored', () => {
    assert.equal(calculateFlip7Score([...numbers(5), special('')], 'classic').finalScore, 5);
});

// --- Brutal: the rows of the scoring table ---------------------------------

function brutalScore(cards, options) {
    return calculateFlip7Score(cards, 'brutal', options);
}

const FLOORED_FLIP_SEVEN = [...SEVEN_SUMMING_28, HALF, minus(10), minus(8), minus(6)];

test('brutal: 5, −10 is −5, with no floor', () => {
    const score = brutalScore([...numbers(5), minus(10)]);

    assert.equal(score.finalScore, -5);
    assert.equal(score.flooredAtZero, false);
});

test('brutal: a hand that floors in Vengeance goes below 0 first, then takes the bonus', () => {
    assert.equal(calculateFlip7Score(FLOORED_FLIP_SEVEN, 'vengeance').finalScore, 15);
    // 28 ÷ 2 = 14, 14 − 24 = −10, −10 + 15 = 5.
    assert.equal(brutalScore(FLOORED_FLIP_SEVEN).finalScore, 5);
});

test('brutal: The Zero stays 0 with minus cards, also with no floor', () => {
    const score = brutalScore([ZERO, ...numbers(12, 11), minus(2)]);

    assert.equal(score.finalScore, 0);
    assert.equal(score.zeroed, true);
});

test('brutal: The Zero with a Flip 7 scores normally', () => {
    assert.equal(brutalScore([ZERO, ...numbers(1, 2, 3, 4, 5, 25)]).finalScore, 55);
});

test('brutal: a bust with −6 is −6', () => {
    const score = brutalScore([minus(6)], { busted: true });

    assert.equal(score.finalScore, -6);
    assert.equal(score.isBust, true);
});

test('brutal: ÷2 has no effect on a bust', () => {
    assert.equal(brutalScore([HALF], { busted: true }).finalScore, 0);
    assert.equal(brutalScore([HALF, minus(6)], { busted: true }).finalScore, -6);
    assert.equal(brutalScore([...numbers(5, 5), HALF, minus(7)]).finalScore, -7);
});

test('brutal: a busted score is minus the sum of every minus card', () => {
    assert.equal(brutalScore([minus(2), minus(4), minus(10)], { busted: true }).finalScore, -16);
});

test('vengeance: a bust with −6 is still 0', () => {
    assert.equal(calculateFlip7Score([minus(6)], 'vengeance', { busted: true }).finalScore, 0);
});

test('brutal: a duplicate bust keeps the modifiers from before it', () => {
    const score = brutalScore([...numbers(5, 5), minus(6)]);

    assert.equal(score.finalScore, -6);
    assert.equal(score.isDuplicateBust, true);
});

test('brutal: The Zero in a busted hand has no effect', () => {
    const score = brutalScore([ZERO, ...numbers(5, 5), minus(6)]);

    assert.equal(score.finalScore, -6);
    assert.equal(score.zeroed, false);
});

test('brutal: a declared bust keeps its cards out of the score', () => {
    assert.equal(brutalScore(numbers(5, 9), { busted: true }).finalScore, 0);
});

test('brutal: the Steal or Swap override undoes the bust, and the score can go below 0', () => {
    const score = brutalScore([...numbers(5, 5), minus(20)], { duplicateAllowed: true });

    assert.equal(score.isBust, false);
    assert.equal(score.finalScore, -10);
});

test('brutal: Lucky 13 and a third 13 busts, and only the minus cards count', () => {
    assert.equal(brutalScore([LUCKY_13, ...numbers(13, 13), minus(2)]).finalScore, -2);
});

// --- Brutal: the Flip 7 attack (X43) --------------------------------------------

test('brutal: a Flip 7 keeps its +15 unless it attacks', () => {
    const hand = numbers(1, 2, 3, 4, 5, 6, 7);

    assert.equal(brutalScore(hand).finalScore, 43);
    assert.equal(brutalScore(hand).bonus, 15);
});

test('brutal: attacking makes the bonus 0', () => {
    const score = brutalScore(numbers(1, 2, 3, 4, 5, 6, 7), { flip7Attack: true });

    assert.equal(score.bonus, 0);
    assert.equal(score.finalScore, 28);
});

test('brutal: attacking with minus cards can leave the attacker below 0', () => {
    const score = brutalScore(FLOORED_FLIP_SEVEN, { flip7Attack: true });

    assert.equal(score.finalScore, -10);
});

test('brutal: The Zero with a Flip 7 can attack too', () => {
    assert.equal(brutalScore([ZERO, ...numbers(1, 2, 3, 4, 5, 25)], { flip7Attack: true }).finalScore, 40);
});

test('the attack option changes nothing on a hand with no bonus', () => {
    assert.equal(brutalScore(numbers(1, 2), { flip7Attack: true }).finalScore, 3);
    assert.equal(brutalScore([minus(4)], { flip7Attack: true, busted: true }).finalScore, -4);
});

test('Classic takes no attack, whatever it is asked', () => {
    assert.equal(calculateFlip7Score(numbers(1, 2, 3, 4, 5, 6, 7), 'classic', { flip7Attack: true }).bonus, 15);
});

test('Vengeance takes no attack, whatever it is asked', () => {
    assert.equal(calculateFlip7Score(numbers(1, 2, 3, 4, 5, 6, 7), 'vengeance', { flip7Attack: true }).bonus, 15);
});

// --- scoreVengeance's options, which Brutal's registry entry sets ---------------

test('scoreVengeance can leave the score below 0 and keep the floor out of the working', () => {
    const score = scoreVengeance([...numbers(5), minus(10)], { canGoNegative: true });

    assert.equal(score.finalScore, -5);
    assert.equal(score.flooredAtZero, false);
});

test('scoreVengeance can count minus cards on a bust, ignoring ÷2', () => {
    const options = { modifiersAfterBust: true, busted: true };

    assert.equal(scoreVengeance([minus(6)], options).finalScore, -6);
    assert.equal(scoreVengeance([minus(6), HALF], options).finalScore, -6);
    assert.equal(scoreVengeance([HALF], options).finalScore, 0);
    assert.equal(scoreVengeance([...numbers(5, 5), minus(6)], { modifiersAfterBust: true }).finalScore, -6);
});

// --- describeScoreBreakdown with the new steps -------------------------------

test('the breakdown shows the floor step before the bonus', () => {
    const floored = calculateFlip7Score([...SEVEN_SUMMING_28, HALF, minus(10), minus(8), minus(6)], 'vengeance');
    const noBonus = calculateFlip7Score([...numbers(5), minus(10)], 'vengeance');

    assert.equal(describeScoreBreakdown(floored), '28 ÷ 2 − 24, floored at 0 + 15 =');
    assert.equal(describeScoreBreakdown(noBonus), '5 − 10, floored at 0 =');
});

test('the breakdown says The Zero wiped the hand', () => {
    const score = calculateFlip7Score([ZERO, ...numbers(12)], 'vengeance');

    assert.equal(describeScoreBreakdown(score), 'The Zero scores 0 without a Flip 7:');
});

// --- CARD_TYPES --------------------------------------------------------------

test('CARD_TYPES keeps the order the card editor offers', () => {
    assert.deepEqual(
        CARD_TYPES.map((cardType) => cardType.value),
        ['number', 'multiplier', 'divisor', 'adder', 'subtractor'],
    );
});
