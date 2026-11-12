// Tests for the manual score entry card helpers. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    MAX_CARDS_PER_ROUND,
    addCard,
    addNextCard,
    cardsPastSeven,
    dropBlankCards,
    cardTypeOption,
    cardTypeOptions,
    isTypeOptionTaken,
    retypeCard,
    sanitizeCard,
    sanitizeCards,
    startingCards,
    switchCardType,
} from '../src/lib/scoreEntryCards.js';

test('startingCards returns restored cards', () => {
    const restored = [{ type: 'number', value: '5' }];

    assert.deepEqual(startingCards(restored), restored);
});

test('startingCards strips the signs from restored modifier values (X34)', () => {
    const restored = [{ type: 'number', value: '5' }, { type: 'multiplier', value: 'x2' }];

    assert.deepEqual(startingCards(restored), [
        { type: 'number', value: '5' },
        { type: 'multiplier', value: '2' },
    ]);
});

test('sanitizeCard keeps only the digits of a modifier value (X34)', () => {
    assert.deepEqual(sanitizeCard({ type: 'multiplier', value: 'x2' }), { type: 'multiplier', value: '2' });
    assert.deepEqual(sanitizeCard({ type: 'multiplier', value: '×2' }), { type: 'multiplier', value: '2' });
    assert.deepEqual(sanitizeCard({ type: 'divisor', value: '÷2' }), { type: 'divisor', value: '2' });
    assert.deepEqual(sanitizeCard({ type: 'adder', value: '+10' }), { type: 'adder', value: '10' });
    assert.deepEqual(sanitizeCard({ type: 'adder', value: '-4' }), { type: 'adder', value: '4' });
    assert.deepEqual(sanitizeCard({ type: 'subtractor', value: '−6' }), { type: 'subtractor', value: '6' });
    assert.deepEqual(sanitizeCard({ type: 'subtractor', value: ' - 8 ' }), { type: 'subtractor', value: '8' });
    assert.deepEqual(sanitizeCard({ type: 'adder', value: undefined }), { type: 'adder', value: '' });
});

test('sanitizeCard leaves number cards alone, so a negative number still counts (X1)', () => {
    assert.deepEqual(sanitizeCard({ type: 'number', value: '-3' }), { type: 'number', value: '-3' });
});

test('sanitizeCards cleans every card', () => {
    const cards = [{ type: 'number', value: '7' }, { type: 'adder', value: '+4' }];

    assert.deepEqual(sanitizeCards(cards), [{ type: 'number', value: '7' }, { type: 'adder', value: '4' }]);
});

test('addCard appends an empty row when the last row has a value', () => {
    const cards = [{ type: 'number', value: '7' }];

    assert.deepEqual(addCard(cards, 'multiplier'), [
        { type: 'number', value: '7' },
        { value: '', type: 'multiplier' },
    ]);
});

test('addCard changes the type of a blank last row instead of adding another (X34)', () => {
    const cards = [{ type: 'number', value: '7' }, { type: 'number', value: ' ' }];

    assert.deepEqual(addCard(cards, 'adder'), [
        { type: 'number', value: '7' },
        { type: 'adder', value: '' },
    ]);
    assert.deepEqual(addCard([{ type: 'divisor', value: '' }], 'number'), [{ type: 'number', value: '' }]);
});

test('addCard adds the first row to an empty list', () => {
    assert.deepEqual(addCard([], 'subtractor'), [{ value: '', type: 'subtractor' }]);
});

test('startingCards gives one empty number row for no, undefined or empty cards', () => {
    const expected = [{ value: '', type: 'number' }];

    assert.deepEqual(startingCards(undefined), expected);
    assert.deepEqual(startingCards(null), expected);
    assert.deepEqual(startingCards([]), expected);
});

test('startingCards gives a fresh row each time', () => {
    assert.notEqual(startingCards([])[0], startingCards([])[0]);
});

test('dropBlankCards removes blank rows of every type and keeps 0', () => {
    const cards = [
        { type: 'number', value: '' },
        { type: 'number', value: '0' },
        { type: 'multiplier', value: '  ' },
        { type: 'divisor', value: '' },
        { type: 'adder', value: undefined },
        { type: 'subtractor', value: '-4' },
    ];

    assert.deepEqual(dropBlankCards(cards), [
        { type: 'number', value: '0' },
        { type: 'subtractor', value: '-4' },
    ]);
});

test('the card limit matches the server', () => {
    assert.equal(MAX_CARDS_PER_ROUND, 30);
});


// --- Game modes (X41, X42) -----------------------------------------------------

test('sanitizeCard turns a typed 0 into The Zero where the mode has one', () => {
    assert.deepEqual(sanitizeCard({ type: 'number', value: '0' }, 'vengeance'), { type: 'special', value: '0' });
    assert.deepEqual(sanitizeCard({ type: 'number', value: ' 00 ' }, 'vengeance'), { type: 'special', value: '0' });
});

test('sanitizeCard leaves a typed 0 and other numbers as numbers elsewhere', () => {
    assert.deepEqual(sanitizeCard({ type: 'number', value: '0' }), { type: 'number', value: '0' });
    assert.deepEqual(sanitizeCard({ type: 'number', value: '0' }, 'classic'), { type: 'number', value: '0' });
    assert.deepEqual(sanitizeCard({ type: 'number', value: '10' }, 'vengeance'), { type: 'number', value: '10' });
    assert.deepEqual(sanitizeCard({ type: 'number', value: '' }, 'vengeance'), { type: 'number', value: '' });
});

test('sanitizeCard keeps a special card as digits only', () => {
    assert.deepEqual(sanitizeCard({ type: 'special', value: '13' }, 'vengeance'), { type: 'special', value: '13' });
    assert.deepEqual(sanitizeCard({ type: 'special', value: 'L13' }), { type: 'special', value: '13' });
});

test('sanitizeCards applies the mode and keeps cards the mode has no buttons for', () => {
    const cards = [{ type: 'number', value: '0' }, { type: 'multiplier', value: 'x2' }];

    assert.deepEqual(sanitizeCards(cards, 'vengeance'), [
        { type: 'special', value: '0' },
        { type: 'multiplier', value: '2' },
    ]);
});

test('startingCards applies the mode to restored cards', () => {
    assert.deepEqual(startingCards([{ type: 'number', value: '0' }], 'vengeance'), [{ type: 'special', value: '0' }]);
});

test('addNextCard appends a number row after a filled or special row, and to an empty list', () => {
    assert.deepEqual(addNextCard([{ type: 'divisor', value: '2' }]), [
        { type: 'divisor', value: '2' },
        { type: 'number', value: '' },
    ]);
    assert.deepEqual(addNextCard([{ type: 'special', value: '13' }]), [
        { type: 'special', value: '13' },
        { type: 'number', value: '' },
    ]);
    assert.deepEqual(addNextCard([]), [{ type: 'number', value: '' }]);
});

test('addNextCard adds another row after a blank one, as each deliberate tap asks for a card', () => {
    assert.deepEqual(addNextCard([{ type: 'subtractor', value: '' }]), [
        { type: 'subtractor', value: '' },
        { type: 'number', value: '' },
    ]);
});

test('cardsPastSeven finds the number and special cards after the seventh', () => {
    const number = (value) => ({ type: 'number', value });
    const sevenCounting = [
        { type: 'special', value: '0' },
        number('1'),
        number(''),
        { type: 'subtractor', value: '4' },
        number('2'),
        number('3'),
        number('4'),
        number('5'),
        number('6'),
    ];

    assert.deepEqual([...cardsPastSeven(sevenCounting)], []);
    assert.deepEqual([...cardsPastSeven([...sevenCounting, { type: 'divisor', value: '2' }])], []);
    assert.deepEqual(
        [...cardsPastSeven([...sevenCounting, number('7'), { type: 'adder', value: '2' }, { type: 'special', value: '13' }])],
        [9, 11],
    );
});

test('switchCardType changes the row, whichever it is, and keeps its value', () => {
    const cards = [{ type: 'number', value: '-5' }, { type: 'number', value: '6' }];

    assert.deepEqual(switchCardType(cards, 0, 'subtractor', 'classic'), {
        cards: [{ type: 'subtractor', value: '5' }, { type: 'number', value: '6' }],
        index: 0,
    });
});

test('switchCardType turns a blank row into a special card', () => {
    const cards = [{ type: 'number', value: '' }, { type: 'number', value: '6' }];

    assert.deepEqual(switchCardType(cards, 0, 'special:13', 'vengeance'), {
        cards: [{ type: 'special', value: '13' }, { type: 'number', value: '6' }],
        index: 0,
    });
});

test('switchCardType adds a special card as a new row when the row has a value', () => {
    const cards = [{ type: 'number', value: '6' }, { type: 'number', value: '' }];

    assert.deepEqual(switchCardType(cards, 0, 'special:7', 'vengeance'), {
        cards: [
            { type: 'number', value: '6' },
            { type: 'number', value: '' },
            { type: 'special', value: '7' },
        ],
        index: 2,
    });
});

test('switchCardType settles a typed 0 before adding a special card beside it', () => {
    assert.deepEqual(switchCardType([{ type: 'number', value: '0' }], 0, 'special:7', 'vengeance').cards, [
        { type: 'special', value: '0' },
        { type: 'special', value: '7' },
    ]);
});

test('isTypeOptionTaken finds only a special card already in the hand', () => {
    const cards = [{ type: 'special', value: '13' }, { type: 'number', value: '7' }];

    assert.equal(isTypeOptionTaken(cards, 'special:13'), true);
    assert.equal(isTypeOptionTaken(cards, 'special:7'), false);
    assert.equal(isTypeOptionTaken(cards, 'number'), false);
});

test('cardTypeOptions offers the types of the mode in order', () => {
    const number = { type: 'number', value: '' };

    assert.deepEqual(cardTypeOptions('classic', number).map((option) => option.value), [
        'number', 'multiplier', 'adder',
    ]);
    assert.deepEqual(cardTypeOptions('vengeance', number), [
        { value: 'number', label: 'Number' },
        { value: 'divisor', label: 'Divide (÷)' },
        { value: 'subtractor', label: 'Subtract (−)' },
        { value: 'special:0', label: 'The Zero' },
        { value: 'special:7', label: 'Unlucky 7' },
        { value: 'special:13', label: 'Lucky 13' },
    ]);
});

test('cardTypeOptions always includes the type of the row, so a restored row stays editable', () => {
    const vengeanceValues = cardTypeOptions('vengeance', { type: 'multiplier', value: '2' }).map((option) => option.value);
    const classicOptions = cardTypeOptions('classic', { type: 'special', value: '13' });
    const oldType = cardTypeOptions('classic', { type: 'wild', value: '9' });

    assert.equal(vengeanceValues.includes('multiplier'), true);
    assert.deepEqual(classicOptions.at(-1), { value: 'special:13', label: 'Lucky 13' });
    assert.deepEqual(oldType.at(-1), { value: 'wild', label: 'wild' });
});

test('cardTypeOption names a row by its type, or its special card', () => {
    assert.equal(cardTypeOption({ type: 'number', value: '13' }), 'number');
    assert.equal(cardTypeOption({ type: 'special', value: '13' }), 'special:13');
});

test('retypeCard turns a row into a special card', () => {
    assert.deepEqual(retypeCard({ type: 'number', value: '13' }, 'special:13', 'vengeance'), { type: 'special', value: '13' });
    assert.deepEqual(retypeCard({ type: 'special', value: '13' }, 'special:7', 'vengeance'), { type: 'special', value: '7' });
});

test('retypeCard keeps the number of a special that becomes a plain number', () => {
    assert.deepEqual(retypeCard({ type: 'special', value: '13' }, 'number', 'vengeance'), { type: 'number', value: '13' });
});

test('retypeCard blanks The Zero, which has no plain number in this deck', () => {
    assert.deepEqual(retypeCard({ type: 'special', value: '0' }, 'number', 'vengeance'), { type: 'number', value: '' });
});

test('retypeCard blanks a special that becomes a modifier', () => {
    assert.deepEqual(retypeCard({ type: 'special', value: '13' }, 'subtractor', 'vengeance'), { type: 'subtractor', value: '' });
});

test('retypeCard keeps a typed value between ordinary types (X34)', () => {
    assert.deepEqual(retypeCard({ type: 'number', value: '-6' }, 'subtractor', 'classic'), { type: 'subtractor', value: '6' });
});

// --- What Classic offers (X57) -----------------------------------------------

test('Classic offers only the base game modifiers, as it has no ÷2 or minus cards (X57)', () => {
    const values = cardTypeOptions('classic', { type: 'number', value: '' }).map((option) => option.value);

    assert.deepEqual(values, ['number', 'multiplier', 'adder']);
});

test('a Classic row already holding a Vengeance card keeps its type on the list (X57)', () => {
    const values = cardTypeOptions('classic', { type: 'subtractor', value: '4' }).map((option) => option.value);

    assert.deepEqual(values, ['number', 'multiplier', 'adder', 'subtractor']);
});

test('Vengeance and Brutal still offer ÷2 and minus cards (X57)', () => {
    for (const mode of ['vengeance', 'brutal']) {
        const values = cardTypeOptions(mode, { type: 'number', value: '' }).map((option) => option.value);

        assert.deepEqual(values, ['number', 'divisor', 'subtractor', 'special:0', 'special:7', 'special:13']);
    }
});
