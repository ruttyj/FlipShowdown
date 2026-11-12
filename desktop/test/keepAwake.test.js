import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createKeepAwake } from '../src/main/keepAwake.js';

/** Stands in for Electron's powerSaveBlocker: hands out ids and records which are active. */
function fakeBlocker() {
    const active = new Set();
    const calls = [];
    let nextId = 1;
    return {
        active,
        calls,
        start(type) {
            calls.push(['start', type]);
            const id = nextId;
            nextId += 1;
            active.add(id);
            return id;
        },
        stop(id) {
            calls.push(['stop', id]);
            active.delete(id);
        },
    };
}

/** Stands in for Electron's powerMonitor: an emitter with a switchable battery flag. */
class FakeMonitor extends EventEmitter {
    /** @param {boolean} onBattery */
    constructor(onBattery) {
        super();
        this.onBattery = onBattery;
    }

    isOnBatteryPower() {
        return this.onBattery;
    }
}

function fakeMonitor(onBattery = false) {
    return new FakeMonitor(onBattery);
}

function setup(onBattery = false) {
    const powerSaveBlocker = fakeBlocker();
    const powerMonitor = fakeMonitor(onBattery);
    const keepAwake = createKeepAwake({ powerSaveBlocker, powerMonitor });
    return { powerSaveBlocker, powerMonitor, keepAwake };
}

// --- Blocking sleep ---

test('start blocks app suspension, not the display', () => {
    const { powerSaveBlocker, keepAwake } = setup();

    keepAwake.start();

    assert.deepEqual(powerSaveBlocker.calls, [['start', 'prevent-app-suspension']]);
});

test('start is idempotent: a second call keeps the one blocker', () => {
    const { powerSaveBlocker, keepAwake } = setup();

    keepAwake.start();
    keepAwake.start();

    assert.equal(powerSaveBlocker.calls.length, 1);
    assert.equal(powerSaveBlocker.active.size, 1);
});

test('stop releases the blocker it started', () => {
    const { powerSaveBlocker, keepAwake } = setup();
    keepAwake.start();

    keepAwake.stop();

    assert.deepEqual(powerSaveBlocker.calls, [['start', 'prevent-app-suspension'], ['stop', 1]]);
    assert.equal(powerSaveBlocker.active.size, 0);
});

test('stop is idempotent and safe before any start', () => {
    const { powerSaveBlocker, keepAwake } = setup();

    keepAwake.stop();
    keepAwake.start();
    keepAwake.stop();
    keepAwake.stop();

    const stopCalls = powerSaveBlocker.calls.filter(([name]) => name === 'stop');
    assert.equal(stopCalls.length, 1);
});

test('start after stop takes a fresh blocker', () => {
    const { powerSaveBlocker, keepAwake } = setup();

    keepAwake.start();
    keepAwake.stop();
    keepAwake.start();

    assert.equal(powerSaveBlocker.active.size, 1);
    assert.equal(powerSaveBlocker.active.has(2), true);
});

// --- Battery ---

test('isOnBattery reports the power monitor', () => {
    const { powerMonitor, keepAwake } = setup(true);
    assert.equal(keepAwake.isOnBattery(), true);

    powerMonitor.onBattery = false;

    assert.equal(keepAwake.isOnBattery(), false);
});

test('onBatteryChange reports on-battery and on-ac switches', () => {
    const { powerMonitor, keepAwake } = setup();
    const seen = [];
    keepAwake.onBatteryChange((onBattery) => seen.push(onBattery));

    powerMonitor.onBattery = true;
    powerMonitor.emit('on-battery');
    powerMonitor.onBattery = false;
    powerMonitor.emit('on-ac');

    assert.deepEqual(seen, [true, false]);
});

test('onBatteryChange returns an unsubscribe that removes both listeners', () => {
    const { powerMonitor, keepAwake } = setup();
    const seen = [];
    const unsubscribe = keepAwake.onBatteryChange((onBattery) => seen.push(onBattery));

    unsubscribe();
    powerMonitor.emit('on-battery');
    powerMonitor.emit('on-ac');

    assert.deepEqual(seen, []);
    assert.equal(powerMonitor.listenerCount('on-battery'), 0);
    assert.equal(powerMonitor.listenerCount('on-ac'), 0);
});
