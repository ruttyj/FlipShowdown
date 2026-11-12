// iOS scrolls the page itself to show a focused field and can leave it there (X50).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installKeyboardScrollReset } from '../src/lib/keyboardScrollReset.js';

function makeTarget() {
    const listeners = new Map();
    return {
        addEventListener: (name, listener) => listeners.set(name, listener),
        removeEventListener: (name) => listeners.delete(name),
        fire: (name) => listeners.get(name)?.(),
        has: (name) => listeners.has(name),
    };
}

function makeWindow({ scrollY = 120, activeElement = { tagName: 'BUTTON' }, hasVisualViewport = true } = {}) {
    const timers = new Map();
    let nextTimer = 1;
    const win = {
        ...makeTarget(),
        scrollY,
        scrolledTo: [],
        document: { ...makeTarget(), activeElement },
        visualViewport: hasVisualViewport ? makeTarget() : undefined,
        scrollTo(x, y) {
            win.scrolledTo.push([x, y]);
            win.scrollY = y;
        },
        setTimeout(callback) {
            timers.set(nextTimer, callback);
            nextTimer += 1;
            return nextTimer - 1;
        },
        clearTimeout: (id) => timers.delete(id),
        runTimers() {
            for (const callback of timers.values()) {
                callback();
            }
            timers.clear();
        },
    };
    return win;
}

test('the page goes back to the top once focus has left a field', () => {
    const win = makeWindow();
    installKeyboardScrollReset(win);

    win.document.fire('focusout');
    assert.deepEqual(win.scrolledTo, [], 'focus may only be moving to another field');
    win.runTimers();

    assert.deepEqual(win.scrolledTo, [[0, 0]]);
});

test('the page goes back to the top when the keyboard finishes closing or the page scrolls', () => {
    const resized = makeWindow();
    installKeyboardScrollReset(resized);
    resized.visualViewport.fire('resize');
    assert.deepEqual(resized.scrolledTo, [[0, 0]]);

    const scrolled = makeWindow();
    installKeyboardScrollReset(scrolled);
    scrolled.fire('scroll');
    assert.deepEqual(scrolled.scrolledTo, [[0, 0]]);
});

for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    test(`the page stays put while a ${tagName} has focus, as iOS is showing it above the keyboard`, () => {
        const win = makeWindow({ activeElement: { tagName } });
        installKeyboardScrollReset(win);

        win.fire('scroll');
        win.document.fire('focusout');
        win.runTimers();

        assert.deepEqual(win.scrolledTo, []);
    });
}

test('the page stays put while editable text has focus', () => {
    const win = makeWindow({ activeElement: { tagName: 'DIV', isContentEditable: true } });
    installKeyboardScrollReset(win);

    win.fire('scroll');

    assert.deepEqual(win.scrolledTo, []);
});

test('a page already at the top is not scrolled', () => {
    const win = makeWindow({ scrollY: 0, activeElement: null });
    installKeyboardScrollReset(win);

    win.fire('scroll');

    assert.deepEqual(win.scrolledTo, []);
});

test('it works without a visual viewport, and removing it stops everything', () => {
    const win = makeWindow({ hasVisualViewport: false });
    const remove = installKeyboardScrollReset(win);
    win.document.fire('focusout');

    remove();
    win.runTimers();

    assert.deepEqual(win.scrolledTo, []);
    assert.equal(win.has('scroll'), false);
    assert.equal(win.document.has('focusout'), false);

    const withViewport = makeWindow();
    installKeyboardScrollReset(withViewport)();
    assert.equal(withViewport.visualViewport.has('resize'), false);
});
