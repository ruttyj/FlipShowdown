import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { changeBust, readHandEntry, startHandEntry } from '../src/lib/handEntry.js';
import { scoreHand } from '../src/lib/handFixes.js';

const number = (value) => ({ type: 'number', value });
const special = (value) => ({ type: 'special', value });
const blank = () => number('');
const TARGETS = [{ id: 'p2' }];
const SEVEN_CARDS = ['1', '2', '3', '4', '5', '6', '7'].map(number);

function differentNumbers(count) {
    return Array.from({ length: count }, (_, index) => number(String(index + 1)));
}

function read(start, context = {}) {
    return readHandEntry(startHandEntry(start, context.gameMode), context);
}

// --- Starting ----------------------------------------------------------------

describe('startHandEntry', () => {
    it('starts empty with nothing chosen', () => {
        assert.deepEqual(startHandEntry(), { cards: [], overrideOn: false, chosenAttackId: null, isBustOn: false });
    });

    it('treats null cards as none', () => {
        assert.deepEqual(startHandEntry({ cards: null }).cards, []);
    });

    it('settles the cards it is given (X34)', () => {
        const entry = startHandEntry({ cards: [{ type: 'multiplier', value: 'x2' }, number('0')] }, 'vengeance');

        assert.deepEqual(entry.cards, [{ type: 'multiplier', value: '2' }, special('0')]);
    });

    it('gives a blank row to type in only when asked and there are no cards', () => {
        assert.deepEqual(startHandEntry({ startsWithBlankRow: true }).cards, [blank()]);
        assert.deepEqual(startHandEntry({ startsWithBlankRow: true, cards: [] }).cards, [blank()]);
        assert.deepEqual(startHandEntry({ startsWithBlankRow: true, cards: [number('5')] }).cards, [number('5')]);
    });

    it('keeps the restored choices', () => {
        const entry = startHandEntry({ duplicateAllowed: true, attackPlayerId: 'p2', busted: true });

        assert.equal(entry.overrideOn, true);
        assert.equal(entry.chosenAttackId, 'p2');
        assert.equal(entry.isBustOn, true);
    });
});

// --- The Bust switch ---------------------------------------------------------

describe('changeBust', () => {
    it('keeps the cards either way', () => {
        const entry = startHandEntry({ cards: [number('5')] });

        assert.deepEqual(changeBust(entry, true).cards, [number('5')]);
        assert.deepEqual(changeBust(entry, false).cards, [number('5')]);
    });

    it('leaves an empty hand empty when turned on, and gives it a row when turned off (X45)', () => {
        const entry = startHandEntry({ busted: true });

        assert.deepEqual(changeBust(entry, true).cards, []);
        assert.deepEqual(changeBust(entry, false).cards, [blank()]);
        assert.equal(changeBust(entry, false).isBustOn, false);
    });
});

// --- Counting and scoring ----------------------------------------------------

describe('readHandEntry: counting and scoring', () => {
    it('counts and scores without the blank rows (X2, X19)', () => {
        const hand = read({ cards: [number('5'), blank(), { type: 'multiplier', value: '' }] });

        assert.deepEqual(hand.countedCards, [number('5')]);
        assert.equal(hand.score.finalScore, 5);
    });

    it('scores a declared bust whatever the cards', () => {
        const hand = read({ cards: [number('5')], busted: true });

        assert.equal(hand.score.isBust, true);
        assert.equal(hand.score.finalScore, 0);
    });

    it('re-scores the same entry when the mode changes', () => {
        const entry = startHandEntry({ cards: [number('10'), { type: 'subtractor', value: '20' }] });

        assert.equal(readHandEntry(entry, { gameMode: 'classic' }).score.finalScore, -10);
        assert.equal(readHandEntry(entry, { gameMode: 'vengeance' }).score.finalScore, 0);
    });

    it('applies the override only to a hand it can undo the bust of (X45)', () => {
        const duplicate = read({ cards: [number('5'), number('5')], duplicateAllowed: true }, { gameMode: 'vengeance' });
        const noDuplicate = read({ cards: [number('5')], duplicateAllowed: true }, { gameMode: 'vengeance' });

        assert.equal(duplicate.score.isBust, false);
        assert.equal(duplicate.score.duplicateAllowed, true);
        assert.equal(noDuplicate.score.duplicateAllowed, false);
    });

    it('offers the override on a duplicate in a mode with it, unless the hand is declared bust', () => {
        const duplicate = [number('5'), number('5')];

        assert.equal(read({ cards: duplicate }, { gameMode: 'vengeance' }).offersOverride, true);
        assert.equal(read({ cards: duplicate }, { gameMode: 'classic' }).offersOverride, false);
        assert.equal(read({ cards: duplicate, busted: true }, { gameMode: 'vengeance' }).offersOverride, false);
    });
});

// --- The Flip 7 choice -------------------------------------------------------

describe('readHandEntry: the Flip 7 choice', () => {
    const context = { gameMode: 'brutal', attackTargets: TARGETS };

    it('sends a chosen rival who is still here, and takes the bonus off (X43)', () => {
        const hand = read({ cards: SEVEN_CARDS, attackPlayerId: 'p2' }, context);

        assert.equal(hand.attackPlayerId, 'p2');
        assert.equal(hand.score.bonus, 0);
        assert.equal(hand.confirmedHand.flip7AttackPlayerId, 'p2');
    });

    it('drops a rival who has left, and keeps the bonus (X43)', () => {
        const hand = read({ cards: SEVEN_CARDS, attackPlayerId: 'gone' }, context);

        assert.equal(hand.attackPlayerId, null);
        assert.equal(hand.score.bonus, 15);
        assert.equal(hand.confirmedHand.flip7AttackPlayerId, null);
    });

    it('has no targets unless told of some', () => {
        const hand = read({ cards: SEVEN_CARDS, attackPlayerId: 'p2' }, { gameMode: 'brutal' });

        assert.equal(hand.attackPlayerId, null);
    });
});

// --- Can it be confirmed? ----------------------------------------------------

describe('readHandEntry: canConfirm', () => {
    it('needs at least one counted card', () => {
        assert.equal(read({ cards: [] }).canConfirm, false);
        assert.equal(read({ cards: [blank()] }).canConfirm, false);
        assert.equal(read({ cards: [number('5')] }).canConfirm, true);
    });

    it('lets a screen that allows it confirm an empty hand', () => {
        assert.equal(read({ cards: [] }, { allowsEmptyHand: true }).canConfirm, true);
        assert.equal(read({ cards: [blank()] }, { allowsEmptyHand: true }).canConfirm, true);
    });

    it('stops above 30 cards and not at 30', () => {
        const atLimit = read({ cards: differentNumbers(30) });
        const overLimit = read({ cards: differentNumbers(31) });

        assert.equal(atLimit.hasTooManyCards, false);
        assert.equal(atLimit.canConfirm, true);
        assert.equal(overLimit.hasTooManyCards, true);
        assert.equal(overLimit.canConfirm, false);
    });

    it('stops above 30 cards even where an empty hand is allowed or the hand is busted', () => {
        const hand = read({ cards: differentNumbers(31), busted: true }, { allowsEmptyHand: true });

        assert.equal(hand.canConfirm, false);
    });

    it('does not count blank rows toward the limit', () => {
        const hand = read({ cards: [...differentNumbers(30), blank()] });

        assert.equal(hand.hasTooManyCards, false);
        assert.equal(hand.confirmedHand.cards.length, 30);
    });
});

// --- What gets sent ----------------------------------------------------------

describe('readHandEntry: confirmedHand', () => {
    function typedZero(rows, gameMode) {
        // A row typed after the start, so it hasn't been settled.
        const entry = { ...startHandEntry({}, gameMode), cards: rows };
        return readHandEntry(entry, { gameMode });
    }

    it('settles a typed 0 that is still waiting for its blur (X42)', () => {
        const hand = typedZero([number('0'), number('5')], 'vengeance');

        assert.deepEqual(hand.countedCards, [number('0'), number('5')]);
        assert.deepEqual(hand.confirmedHand.cards, [special('0'), number('5')]);
    });

    it('leaves a typed 0 as a number in a mode without The Zero', () => {
        assert.deepEqual(typedZero([number('0')], 'classic').confirmedHand.cards, [number('0')]);
    });

    it('carries the score along with the cards', () => {
        const hand = read({ cards: [number('5')] });

        assert.deepEqual(hand.confirmedHand, { cards: [number('5')], ...hand.score });
    });

    // The score editor used to preview the rows and save a score of the settled cards. These are the
    // only rows settling changes after they are in state, and the score has to be the same either way.
    for (const gameMode of ['classic', 'vengeance', 'brutal']) {
        const hands = [
            [number('0')],
            [number('00')],
            [number(' 0 ')],
            [number('0'), number('0')],
            [number('0'), special('0')],
            [number('0'), number('5'), { type: 'multiplier', value: '2' }],
            [number('0'), { type: 'subtractor', value: '4' }],
            [number('0'), ...['1', '2', '3', '4', '5', '6'].map(number)],
            [number('0'), number('13'), special('13')],
        ];

        for (const rows of hands) {
            it(`scores ${JSON.stringify(rows.map((card) => card.value))} the same before and after settling in ${gameMode}`, () => {
                const hand = typedZero(rows, gameMode);

                assert.deepEqual(hand.score, scoreHand(hand.confirmedHand.cards, gameMode));
            });
        }
    }
});
