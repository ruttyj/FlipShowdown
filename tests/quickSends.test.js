// Tests for the pure quick-send list operations. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_QUICK_SENDS,
    MAX_QUICK_SENDS,
    addQuickSend,
    moveQuickSend,
    quickSendRecipientIds,
    quickSendsKey,
    removeQuickSend,
    toQuickSendList,
    updateQuickSendAt,
} from '../src/lib/quickSends.js';

const A = { emoji: 'a', message: 'one', recipients: [] };
const B = { emoji: 'b', message: 'two', recipients: [] };
const C = { emoji: 'c', message: 'three', recipients: [] };
const D = { emoji: 'd', message: 'four', recipients: [] };

test('quickSendsKey is per room', () => {
    assert.equal(quickSendsKey('r1'), 'quick_sends_r1');
});

test('toQuickSendList keeps saved lists, even an empty one, and gives defaults otherwise', () => {
    assert.deepEqual(toQuickSendList([A]), [A]);
    assert.deepEqual(toQuickSendList([]), []);
    assert.deepEqual(toQuickSendList([A, B, C, D, { emoji: 'e' }]), [A, B, C, D]);
    for (const value of [null, undefined, 'x', 5, { 0: A }]) {
        assert.deepEqual(toQuickSendList(value), DEFAULT_QUICK_SENDS);
    }
});

test('the defaults are four emoji for everyone, within the cap', () => {
    assert.equal(MAX_QUICK_SENDS, 4);
    assert.deepEqual(DEFAULT_QUICK_SENDS.map(combo => combo.emoji), ['❤️', '🥶', '🤬', '🥷']);
    for (const combo of DEFAULT_QUICK_SENDS) {
        assert.equal(combo.toEveryone, true);
    }
});

test('quickSendRecipientIds sends to everyone or to the saved recipients still present', () => {
    const others = [{ id: 'p2' }, { id: 'p3' }];

    assert.deepEqual(quickSendRecipientIds(DEFAULT_QUICK_SENDS[0], others), ['p2', 'p3']);
    assert.deepEqual(quickSendRecipientIds({ ...A, recipients: ['p3', 'gone'] }, others), ['p3']);
    assert.deepEqual(quickSendRecipientIds({ emoji: 'x' }, others), []);
});

test('addQuickSend puts the entry first, replaces a same combo and caps the list', () => {
    assert.deepEqual(addQuickSend([A, B], C), [C, A, B]);
    assert.deepEqual(addQuickSend([A, B], { ...A, recipients: ['x'] }), [{ ...A, recipients: ['x'] }, B]);

    const full = addQuickSend([A, B, C, D], { emoji: 'e', message: 'five', recipients: [] });
    assert.equal(full.length, MAX_QUICK_SENDS);
    assert.equal(full[0].emoji, 'e');
    assert.deepEqual(full.slice(1), [A, B, C]);
});

test('removeQuickSend drops one index without mutating', () => {
    const list = [A, B, C];

    assert.deepEqual(removeQuickSend(list, 1), [A, C]);
    assert.deepEqual(removeQuickSend(list, 9), [A, B, C]);
    assert.deepEqual(list, [A, B, C]);
});

test('moveQuickSend reorders without mutating', () => {
    const list = [A, B, C];

    assert.deepEqual(moveQuickSend(list, 0, 2), [B, C, A]);
    assert.deepEqual(moveQuickSend(list, 2, 0), [C, A, B]);
    assert.deepEqual(list, [A, B, C]);
});

test('updateQuickSendAt merges into one combo only', () => {
    const list = [A, B];

    assert.deepEqual(updateQuickSendAt(list, 1, { message: 'new' }), [A, { ...B, message: 'new' }]);
    assert.deepEqual(updateQuickSendAt(list, 5, { message: 'new' }), [A, B]);
    assert.deepEqual(list, [A, B]);
});
