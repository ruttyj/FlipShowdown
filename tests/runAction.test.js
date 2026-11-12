// Tests for runAction. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAction } from '../src/lib/runAction.js';

function makeBusyRecorder() {
    const states = [];
    return { states, setBusy: (isBusy) => states.push(isBusy) };
}

test('success resolves the result and clears busy', async () => {
    const { states, setBusy } = makeBusyRecorder();

    const result = await runAction('Start', async () => 42, { setBusy });

    assert.equal(result, 42);
    assert.deepEqual(states, [true, false]);
});

test('failure resolves undefined, clears busy and shows the label and message', async () => {
    const { states, setBusy } = makeBusyRecorder();
    const toasts = [];

    const result = await runAction(
        'Start game',
        async () => {
            throw new Error('boom');
        },
        { setBusy, showToast: (message) => toasts.push(message) },
    );

    assert.equal(result, undefined);
    assert.deepEqual(states, [true, false]);
    assert.deepEqual(toasts, ['Start game failed: boom']);
});

test('an error without a message shows "unknown error"', async () => {
    const toasts = [];

    await runAction('Save', () => Promise.reject({ status: 500 }), { showToast: (m) => toasts.push(m) });
    await runAction('Save', () => Promise.reject(null), { showToast: (m) => toasts.push(m) });

    assert.deepEqual(toasts, ['Save failed: unknown error', 'Save failed: unknown error']);
});

test('a 401 shows no toast but still clears busy', async () => {
    const { states, setBusy } = makeBusyRecorder();
    const toasts = [];

    await runAction('Save', () => Promise.reject({ status: 401, message: 'no' }), {
        setBusy,
        showToast: (message) => toasts.push(message),
    });

    assert.deepEqual(toasts, []);
    assert.deepEqual(states, [true, false]);
});

test('runs without options', async () => {
    assert.equal(await runAction('Go', async () => 'ok'), 'ok');
});

test('the default toast does not throw outside a browser', async () => {
    const result = await runAction('Go', () => Promise.reject(new Error('x')));

    assert.equal(result, undefined);
});

test('a failure without setBusy still resolves undefined', async () => {
    const result = await runAction('Go', () => Promise.reject(new Error('x')), { showToast: () => {} });

    assert.equal(result, undefined);
});
