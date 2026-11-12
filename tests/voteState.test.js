// Tests for the hold-to-vote display helpers. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    formatCountdown,
    hostVoteStage,
    optionState,
    remainingMsAt,
    unlocksInMsAt,
} from '../src/lib/voteState.js';

function stateFor(overrides, receivedAt = 1000) {
    return { eligible: ['a', 'b', 'c'], holds: [], pending: null, unlocksInMs: 0, receivedAt, ...overrides };
}

test('no vote state yet is idle', () => {
    const result = optionState(null, 'a', 'me', 0);
    assert.deepEqual(result, { status: 'idle', holderIds: [], iHold: false, remainingMs: 0 });
});

test('idle when nobody holds the option', () => {
    const state = stateFor({ holds: [{ playerId: 'b', option: 'c' }] });
    assert.equal(optionState(state, 'a', 'me', 1000).status, 'idle');
});

test('mine when only I hold it', () => {
    const state = stateFor({ holds: [{ playerId: 'a', option: 'x' }] });
    const result = optionState(state, 'x', 'a', 1000);
    assert.equal(result.status, 'mine');
    assert.deepEqual(result.holderIds, ['a']);
});

test('others when another player holds it and I do not', () => {
    const state = stateFor({ holds: [{ playerId: 'b', option: 'x' }] });
    assert.equal(optionState(state, 'x', 'a', 1000).status, 'others');
});

test('mine when both of us hold it', () => {
    const state = stateFor({
        holds: [{ playerId: 'a', option: 'x' }, { playerId: 'b', option: 'x' }],
    });
    const result = optionState(state, 'x', 'a', 1000);
    assert.equal(result.status, 'mine');
    assert.deepEqual(result.holderIds, ['a', 'b']);
});

test('a countdown says whether I am one of the holders', () => {
    const state = stateFor({
        holds: [{ playerId: 'b', option: 'x' }],
        pending: { option: 'x', remainingMs: 3000 },
    });
    assert.equal(optionState(state, 'x', 'a', 1000).iHold, false);
    assert.equal(optionState(state, 'x', 'b', 1000).iHold, true);
});

test('holds by players who are not eligible are ignored', () => {
    const state = stateFor({ holds: [{ playerId: 'gone', option: 'x' }] });
    assert.equal(optionState(state, 'x', 'a', 1000).status, 'idle');
});

test('pending for the counted-down option only', () => {
    const state = stateFor({
        holds: [{ playerId: 'a', option: 'x' }, { playerId: 'b', option: 'x' }],
        pending: { option: 'x', remainingMs: 3000 },
    });
    assert.equal(optionState(state, 'x', 'a', 1000).status, 'pending');
    assert.equal(optionState(state, 'y', 'a', 1000).status, 'idle');
});

test('countdown reduces by the time since the message arrived', () => {
    const state = stateFor({ pending: { option: 'x', remainingMs: 3000 } }, 1000);
    assert.equal(remainingMsAt(state, 1000), 3000);
    assert.equal(remainingMsAt(state, 1800), 2200);
    assert.equal(remainingMsAt(state, 9000), 0);
    assert.equal(optionState(state, 'x', 'a', 1500).remainingMs, 2500);
});

test('the wait for an offline host counts down from when the message arrived', () => {
    const state = stateFor({ unlocksInMs: 60_000 }, 1000);
    assert.equal(unlocksInMsAt(state, 1000), 60_000);
    assert.equal(unlocksInMsAt(state, 31_000), 30_000);
    assert.equal(unlocksInMsAt(state, 100_000), 0);
});

test('there is no wait without a time left or vote state', () => {
    assert.equal(unlocksInMsAt(stateFor({}), 1000), 0);
    assert.equal(unlocksInMsAt(null, 1000), 0);
});

test('a countdown shows minutes and seconds, rounding up', () => {
    assert.equal(formatCountdown(120_000), '2:00');
    assert.equal(formatCountdown(101_001), '1:42');
    assert.equal(formatCountdown(9_000), '0:09');
    assert.equal(formatCountdown(1), '0:01');
    assert.equal(formatCountdown(0), '0:00');
});

test('remaining time is 0 without a pending countdown', () => {
    assert.equal(remainingMsAt(stateFor({}), 5000), 0);
    assert.equal(remainingMsAt(null, 5000), 0);
});

// --- Replacing an offline host ---------------------------------------------------

test('the vote for a new host is hidden while the host is online', () => {
    assert.equal(hostVoteStage(stateFor({ eligible: ['host', 'a'] }), null, 1000), 'hidden');
    assert.equal(hostVoteStage(stateFor({ eligible: ['a'], unlocksInMs: 5000 }), null, 1000), 'hidden');
});

test('the vote for a new host is hidden until a message counts the host as offline', () => {
    assert.equal(hostVoteStage(null, 'host', 1000), 'hidden');
    assert.equal(hostVoteStage(stateFor({ eligible: ['host', 'a'] }), 'host', 1000), 'hidden');
});

test('the vote for a new host waits out the time left, then opens', () => {
    const state = stateFor({ eligible: ['a'], unlocksInMs: 5000 }, 1000);
    assert.equal(hostVoteStage(state, 'host', 1000), 'waiting');
    assert.equal(hostVoteStage(state, 'host', 5999), 'waiting');
    assert.equal(hostVoteStage(state, 'host', 6000), 'open');
});
