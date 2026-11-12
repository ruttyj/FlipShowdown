// Tests for the rounds the score editor lists. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editableRounds } from '../src/lib/editableRounds.js';

test('lists unique rounds in ascending order', () => {
    const scores = [{ round_number: 3 }, { round_number: 1 }, { round_number: 3 }, { round_number: 2 }];

    assert.deepEqual(editableRounds(scores, 3), [1, 2, 3]);
});

test('adds the current round when it has no scores yet', () => {
    const scores = [{ round_number: 1 }, { round_number: 2 }];

    assert.deepEqual(editableRounds(scores, 4), [1, 2, 4]);
});

test('with no scores it is just the current round', () => {
    assert.deepEqual(editableRounds([], 1), [1]);
});
