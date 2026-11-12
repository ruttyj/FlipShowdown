// Tests for the bottom clearance that keeps page content clear of the floating button stacks.
// Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floatingStacksClearance, floatingStacksTop } from '../src/lib/floatingStacks.js';

test('without quick sends the right-hand toggle stack is the tallest', () => {
    // bottom-4 + four 40px toggles + three 8px gaps
    assert.equal(floatingStacksTop(0), 200);
});

test('one quick send still sits below the top of the toggle stack', () => {
    // 96 + 48 + 6px badge
    assert.equal(floatingStacksTop(1), 200);
});

test('four quick sends make the left stack the tallest', () => {
    // 96 + 4 * 48 + 3 * 12 + 6px badge
    assert.equal(floatingStacksTop(4), 330);
});

test('the clearance adds breathing room and the safe-area inset', () => {
    assert.deepEqual(floatingStacksClearance(4), {
        paddingBottom: 'calc(346px + env(safe-area-inset-bottom))',
    });
    assert.deepEqual(floatingStacksClearance(), {
        paddingBottom: 'calc(216px + env(safe-area-inset-bottom))',
    });
});
