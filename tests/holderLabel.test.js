// Tests for the vote button's "Holding" names. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holderLabel } from '../src/lib/holderLabel.js';

const NAMES = { p1: 'Ada', p2: 'Bo', p3: 'Cy' };

test('no holders gives an empty string', () => {
    assert.equal(holderLabel([], NAMES), '');
});

test('one holder gives that name', () => {
    assert.equal(holderLabel(['p1'], NAMES), 'Ada');
});

test('two holders are joined with a comma and space', () => {
    assert.equal(holderLabel(['p2', 'p1'], NAMES), 'Bo, Ada');
});

test('many holders keep their order', () => {
    assert.equal(holderLabel(['p3', 'p1', 'p2'], NAMES), 'Cy, Ada, Bo');
});

test('an unknown id or missing names map shows a question mark', () => {
    assert.equal(holderLabel(['p1', 'zz'], NAMES), 'Ada, ?');
    assert.equal(holderLabel(['p1'], undefined), '?');
});
