import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ipcChannels from '../src/shared/ipcChannels.cjs';

const { INVOKE_CHANNELS, EVENT_CHANNELS } = ipcChannels;

const PRELOAD_SOURCE = fs.readFileSync(new URL('../src/preload/preload.cjs', import.meta.url), 'utf8');

// Every bridge method that pushes events, with the event channel it should listen on.
const SUBSCRIPTIONS = {
    onState: EVENT_CHANNELS.state,
    onUrlChanged: EVENT_CHANNELS.urlChanged,
    onPowerStatus: EVENT_CHANNELS.powerStatus,
    onRoomStats: EVENT_CHANNELS.roomStats,
};

/**
 * Runs the preload the way a sandboxed renderer does: `require` knows only 'electron', so any
 * other require (such as the shared channel list) fails the test. Returns the exposed bridge
 * and a record of the IPC calls it makes.
 */
function loadPreload() {
    const exposed = {};
    const invoked = [];
    const listeners = new Map();
    const ipcRenderer = {
        invoke(channel, ...args) {
            invoked.push({ channel, args });
            return Promise.resolve();
        },
        on(channel, listener) {
            listeners.set(channel, listener);
        },
        removeListener(channel, listener) {
            if (listeners.get(channel) === listener) {
                listeners.delete(channel);
            }
        },
    };
    const contextBridge = {
        exposeInMainWorld(name, api) {
            exposed[name] = api;
        },
    };
    const sandboxedRequire = (name) => {
        if (name !== 'electron') {
            throw new Error(`A sandboxed preload cannot require ${name}`);
        }
        return { contextBridge, ipcRenderer };
    };

    vm.runInNewContext(PRELOAD_SOURCE, { require: sandboxedRequire, module: { exports: {} } });
    return { bridge: exposed.launcher, invoked, listeners };
}

test('the preload only requires electron, so it runs in a sandboxed renderer', () => {
    const { bridge } = loadPreload();

    assert.equal(typeof bridge, 'object');
});

test('every request method invokes its channel from the shared channel list', () => {
    const { bridge, invoked } = loadPreload();

    for (const name of Object.keys(INVOKE_CHANNELS)) {
        bridge[name]('argument');
    }

    const channels = invoked.map((call) => call.channel);
    assert.deepEqual(channels, Object.values(INVOKE_CHANNELS));
});

test('the bridge exposes exactly the request and event methods', () => {
    const { bridge } = loadPreload();

    const expected = [...Object.keys(INVOKE_CHANNELS), ...Object.keys(SUBSCRIPTIONS)].sort();
    assert.deepEqual(Object.keys(bridge).sort(), expected);
});

test('requests pass their argument through to the main process', () => {
    const { bridge, invoked } = loadPreload();

    bridge.saveSettings({ geminiModel: 'x' });
    bridge.validateGeminiKey('key');
    bridge.openExternal('https://github.com');

    assert.deepEqual(invoked.map((call) => call.args), [[{ geminiModel: 'x' }], ['key'], ['https://github.com']]);
});

test('every event method listens on its channel from the shared channel list', () => {
    const { bridge, listeners } = loadPreload();
    const received = [];

    for (const [name, channel] of Object.entries(SUBSCRIPTIONS)) {
        bridge[name]((payload) => received.push(payload));
        listeners.get(channel)({ sender: 'hidden' }, channel);
    }

    assert.deepEqual(received, Object.values(EVENT_CHANNELS));
});

test('an event subscription can be removed, and needs a function', () => {
    const { bridge, listeners } = loadPreload();

    const unsubscribe = bridge.onState(() => {});
    unsubscribe();

    assert.equal(listeners.has(EVENT_CHANNELS.state), false);
    // Matched by message: the preload runs in its own realm, so its TypeError isn't ours.
    assert.throws(() => bridge.onState('not a function'), /callback must be a function/);
});
