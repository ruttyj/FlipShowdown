// The "wrong deck" hint: a classic scan that read cards only Vengeance has. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WRONG_DECK_HINT, wrongDeckHint } from '../src/lib/wrongDeckHint.js';

const number = (value) => ({ value, type: 'number' });

test('the words are the agreed ones', () => {
    assert.equal(WRONG_DECK_HINT, 'These look like Vengeance cards. Ask the host to switch');
});

test('a classic scan with a 13 gets the hint', () => {
    assert.equal(wrongDeckHint('classic', [number('5'), number('13')]), WRONG_DECK_HINT);
});

test('a classic scan with a ÷2 gets the hint', () => {
    assert.equal(wrongDeckHint('classic', [{ value: '÷2', type: 'divisor' }]), WRONG_DECK_HINT);
});

test('a classic scan of classic cards gets no hint', () => {
    const cards = [number('12'), number('0'), { value: 'x2', type: 'multiplier' }, { value: '+4', type: 'adder' }];

    assert.equal(wrongDeckHint('classic', cards), null);
    assert.equal(wrongDeckHint('classic', []), null);
});

test('a scan with the Vengeance prompt gets no hint, as those cards are right for it', () => {
    const cards = [number('13'), { value: '÷2', type: 'divisor' }, { value: '13', type: 'special' }];

    assert.equal(wrongDeckHint('vengeance', cards), null);
});

test('a classic scan with a minus card gets the hint, as the base game has none (X57)', () => {
    assert.equal(wrongDeckHint('classic', [{ value: '-4', type: 'subtractor' }]), WRONG_DECK_HINT);
});
