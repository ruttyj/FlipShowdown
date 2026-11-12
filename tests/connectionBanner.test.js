import test from 'node:test';
import assert from 'node:assert/strict';
import {
    advanceConnectionClock,
    bannerState,
    createConnectionClock,
    downForMs,
    RECONNECT_DELAY_MS,
} from '../src/lib/connectionBanner.js';

test('live is always hidden', () => {
    assert.equal(bannerState('live', 0, true), 'hidden');
    assert.equal(bannerState('live', 99999, true), 'hidden');
});

test('signed-out shows immediately once a socket has been live', () => {
    assert.equal(bannerState('signed-out', 0, true), 'signed-out');
});

test('signed-out without ever being live stays hidden (fresh page load)', () => {
    assert.equal(bannerState('signed-out', 0, false), 'hidden');
});

test('clock: live then signed-out shows the bar; signed-out from the start does not', () => {
    const wasLive = advanceConnectionClock(createConnectionClock('live'), 'signed-out', 100);
    assert.equal(bannerState(wasLive.status, 0, wasLive.hasBeenLive), 'signed-out');

    const neverLive = advanceConnectionClock(createConnectionClock('signed-out'), 'signed-out', 100);
    assert.equal(bannerState(neverLive.status, 0, neverLive.hasBeenLive), 'hidden');
});

test('first connect before any live stays hidden', () => {
    assert.equal(bannerState('connecting', 99999, false), 'hidden');
    assert.equal(bannerState('reconnecting', 99999, false), 'hidden');
});

test('reconnecting waits for the delay', () => {
    assert.equal(bannerState('reconnecting', RECONNECT_DELAY_MS - 1, true), 'hidden');
    assert.equal(bannerState('reconnecting', RECONNECT_DELAY_MS, true), 'reconnecting');
});

test('connecting after having been live also shows after the delay', () => {
    assert.equal(bannerState('connecting', 500, true), 'hidden');
    assert.equal(bannerState('connecting', 3000, true), 'reconnecting');
});

// --- Connection clock ----------------------------------------------------------

function clockAfter(steps) {
    let clock = createConnectionClock(steps[0][0]);
    for (const [status, now] of steps.slice(1)) {
        clock = advanceConnectionClock(clock, status, now);
    }
    return clock;
}

test('retries after a drop keep the time the socket left live', () => {
    const clock = clockAfter([
        ['live'],
        ['reconnecting', 1000],
        ['connecting', 1500],
        ['reconnecting', 2500],
        ['connecting', 2900],
    ]);

    assert.equal(clock.downSince, 1000);
    assert.equal(downForMs(clock, 3000), 2000);
    assert.equal(bannerState(clock.status, downForMs(clock, 3000), clock.hasBeenLive), 'reconnecting');
});

test('going live clears the clock, and the next drop starts it again', () => {
    let clock = clockAfter([['live'], ['reconnecting', 1000], ['live', 4000]]);
    assert.equal(clock.downSince, null);
    assert.equal(downForMs(clock, 9000), 0);

    clock = advanceConnectionClock(clock, 'reconnecting', 9000);
    assert.equal(clock.downSince, 9000);
});

test('the first connect on page load starts no clock until a socket was live', () => {
    let clock = clockAfter([['connecting'], ['reconnecting', 1000], ['connecting', 2000]]);
    assert.equal(clock.hasBeenLive, false);
    assert.equal(clock.downSince, null);

    clock = advanceConnectionClock(clock, 'live', 3000);
    clock = advanceConnectionClock(clock, 'reconnecting', 3500);
    assert.equal(clock.hasBeenLive, true);
    assert.equal(clock.downSince, 3500);
});

test('repeating the same status returns the same clock', () => {
    const live = createConnectionClock('live');
    assert.equal(advanceConnectionClock(live, 'live', 100), live);

    const down = advanceConnectionClock(live, 'reconnecting', 100);
    assert.equal(advanceConnectionClock(down, 'reconnecting', 200), down);
});
