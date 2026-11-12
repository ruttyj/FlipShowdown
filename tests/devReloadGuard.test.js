import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdReloadOnDisconnect } from '../src/lib/devReloadGuard.js';

// A stand-in for `import.meta.hot` that records the listeners registered on it.
function makeHot() {
    const listeners = new Map();
    return {
        listeners,
        on(event, listener) {
            listeners.set(event, listener);
        },
    };
}

// --- holdReloadOnDisconnect ----------------------------------------------------

test('the dev client never finishes handling a dropped HMR socket, so it never reloads the page', async () => {
    const hot = makeHot();

    holdReloadOnDisconnect(hot);

    const listener = hot.listeners.get('vite:ws:disconnect');
    assert.equal(typeof listener, 'function');
    // Vite awaits this before calling location.reload(); it must stay pending.
    const outcome = await Promise.race([
        Promise.resolve(listener()).then(() => 'settled'),
        new Promise((resolve) => setTimeout(() => resolve('pending'), 20)),
    ]);
    assert.equal(outcome, 'pending');
});

test('outside the dev server (no import.meta.hot) nothing happens', () => {
    assert.doesNotThrow(() => holdReloadOnDisconnect(undefined));
});
