import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSenderCheck, registerIpcHandlers, OPEN_GAME_DELAY_MS } from '../src/main/ipc.js';
import ipcChannels from '../src/shared/ipcChannels.cjs';

const { INVOKE_CHANNELS, EVENT_CHANNELS } = ipcChannels;

const TRUSTED_EVENT = { trusted: true };
const TUNNEL_URL = 'https://brave-otter.trycloudflare.com';
const ROOM_STATS = {
    playersOnline: 3,
    roomsLive: 1,
    rooms: [{ code: 'FW6XK6', status: 'playing', round: 2, maxScore: 200, online: 3, players: 4 }],
};

// --- Fakes ---

/** Stands in for ipcMain: keeps the handlers so tests can invoke them like a renderer would. */
function fakeIpcMain() {
    const handlers = new Map();
    return {
        handlers,
        handle(channel, handler) {
            if (handlers.has(channel)) {
                throw new Error(`Second handler for ${channel}`);
            }
            handlers.set(channel, handler);
        },
        removeHandler(channel) {
            handlers.delete(channel);
        },
    };
}

function snapshot(overrides = {}) {
    return {
        status: 'idle',
        port: null,
        url: null,
        previousUrl: null,
        error: null,
        retry: null,
        serverLog: [],
        tunnelLog: [],
        ...overrides,
    };
}

/** A hosting session whose state the test sets; it records the calls it gets. */
class FakeSession extends EventEmitter {
    calls = [];
    state = snapshot();

    getState() {
        return this.state;
    }

    async start() {
        this.calls.push('start');
        return this.state;
    }

    async retry() {
        this.calls.push('retry');
        return this.state;
    }

    async stop() {
        this.calls.push('stop');
        this.state = snapshot();
    }

    /** Changes the state and emits it, as the real session does. */
    publish(overrides) {
        this.state = snapshot(overrides);
        this.emit('state', this.state);
    }
}

function fakeSettingsStore() {
    const store = {
        settings: { geminiApiKey: '', geminiModel: 'gemini-3.5-flash-lite' },
        resetCount: 0,
        resetError: null,
        load() {
            return { ...store.settings };
        },
        save(changes) {
            store.settings = { ...store.settings, ...changes };
            return { ...store.settings };
        },
        resetData() {
            if (store.resetError) {
                throw store.resetError;
            }
            store.resetCount += 1;
        },
    };
    return store;
}

function fakeKeepAwake() {
    const listeners = new Set();
    return {
        onBattery: false,
        listeners,
        isOnBattery() {
            return this.onBattery;
        },
        onBatteryChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        emitChange(onBattery) {
            this.onBattery = onBattery;
            for (const listener of listeners) {
                listener(onBattery);
            }
        },
    };
}

/** The launcher window: visible until the test hides it; show() fires the shown listeners. */
function fakeWindowVisibility() {
    const listeners = new Set();
    return {
        visible: true,
        listeners,
        isVisible() {
            return this.visible;
        },
        onShown(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        show() {
            this.visible = true;
            for (const listener of listeners) {
                listener();
            }
        },
    };
}

/** Builds every dependency as a fake, registers the handlers and returns the lot. */
const LICENSE_PATHS = {
    app: '/res/LICENSE.txt',
    'third-party': '/res/dist/THIRD_PARTY_NOTICES.txt',
    cloudflared: '/res/cloudflared/LICENSE.txt',
};

function setup(overrides = {}) {
    let currentTime = 1_000;
    const deps = {
        ipcMain: fakeIpcMain(),
        session: new FakeSession(),
        settingsStore: fakeSettingsStore(),
        keepAwake: fakeKeepAwake(),
        sent: [],
        opened: [],
        openedPaths: [],
        openPathError: '',
        sleeps: [],
        keyChecks: [],
        appVersion: '1.2.3',
        windowVisibility: fakeWindowVisibility(),
        ...overrides,
    };
    const unregister = registerIpcHandlers({
        ipcMain: deps.ipcMain,
        session: deps.session,
        settingsStore: deps.settingsStore,
        keepAwake: deps.keepAwake,
        appVersion: deps.appVersion,
        checkGeminiKey: async (key) => {
            deps.keyChecks.push(key);
            return 'valid';
        },
        checkForUpdate: async () => ({ updateAvailable: true, latestVersion: '1.3.0', url: 'https://github.com/x/y/releases/tag/v1.3.0' }),
        openExternal: async (url) => {
            deps.opened.push(url);
        },
        openPath: async (filePath) => {
            deps.openedPaths.push(filePath);
            return deps.openPathError;
        },
        licensePaths: LICENSE_PATHS,
        send: (channel, payload) => deps.sent.push({ channel, payload }),
        isTrustedSender: (event) => event.trusted === true,
        windowVisibility: deps.windowVisibility,
        now: () => currentTime,
        sleep: async (ms) => {
            deps.sleeps.push(ms);
            currentTime += ms;
        },
    });

    function invoke(name, ...args) {
        const handler = deps.ipcMain.handlers.get(INVOKE_CHANNELS[name]);
        return handler(TRUSTED_EVENT, ...args);
    }

    function advanceTime(ms) {
        currentTime += ms;
    }

    return { ...deps, unregister, invoke, advanceTime };
}

// --- Registration ---

test('registers one handler per invoke channel', () => {
    const { ipcMain } = setup();

    assert.deepEqual([...ipcMain.handlers.keys()].sort(), Object.values(INVOKE_CHANNELS).sort());
});

test('unregister removes the handlers and stops forwarding events', () => {
    const { ipcMain, session, keepAwake, windowVisibility, sent, unregister } = setup();

    unregister();
    session.publish({ status: 'hosting' });
    session.emit('url-changed', { previousUrl: 'a', url: 'b' });
    session.emit('room-stats', ROOM_STATS);
    keepAwake.emitChange(true);
    windowVisibility.show();

    assert.equal(ipcMain.handlers.size, 0);
    assert.deepEqual(sent, []);
    assert.equal(keepAwake.listeners.size, 0);
    assert.equal(windowVisibility.listeners.size, 0);
});

test('every handler rejects a sender that is not the launcher window', async () => {
    const { ipcMain, session } = setup();

    for (const handler of ipcMain.handlers.values()) {
        await assert.rejects(async () => handler({ trusted: false }), /Untrusted IPC sender/);
    }
    assert.deepEqual(session.calls, []);
});

// --- Hosting ---

test('start, retry and getState return the session snapshot', async () => {
    const { session, invoke } = setup();
    session.state = snapshot({ status: 'hosting', url: TUNNEL_URL });

    assert.deepEqual(await invoke('start'), session.state);
    assert.deepEqual(await invoke('retry'), session.state);
    assert.deepEqual(await invoke('getState'), session.state);
    assert.deepEqual(session.calls, ['start', 'retry']);
});

test('stop stops the session and returns the snapshot after it', async () => {
    const { session, invoke } = setup();
    session.state = snapshot({ status: 'hosting' });

    const result = await invoke('stop');

    assert.deepEqual(session.calls, ['stop']);
    assert.equal(result.status, 'idle');
});

test('state and url-changed events are pushed to the renderer', () => {
    const { session, sent } = setup();

    session.publish({ status: 'hosting', url: TUNNEL_URL });
    session.emit('url-changed', { previousUrl: TUNNEL_URL, url: 'https://new.trycloudflare.com' });

    assert.deepEqual(sent, [
        { channel: EVENT_CHANNELS.state, payload: session.state },
        { channel: EVENT_CHANNELS.urlChanged, payload: { previousUrl: TUNNEL_URL, url: 'https://new.trycloudflare.com' } },
    ]);
});

// --- Room stats (X66) ---

function roomStatsSent(sent) {
    return sent.filter((message) => message.channel === EVENT_CHANNELS.roomStats).map((message) => message.payload);
}

test('room stats are sent while the window is visible, and answered from the cache', async () => {
    const { session, sent, invoke } = setup();

    assert.equal(await invoke('getRoomStats'), null);
    session.emit('room-stats', ROOM_STATS);

    assert.deepEqual(roomStatsSent(sent), [ROOM_STATS]);
    assert.deepEqual(await invoke('getRoomStats'), ROOM_STATS);
});

test('while the window is hidden room stats are only cached, and showing it sends the latest once', async () => {
    const { session, windowVisibility, sent, invoke } = setup();
    windowVisibility.visible = false;

    session.emit('room-stats', { ...ROOM_STATS, playersOnline: 1 });
    session.emit('room-stats', ROOM_STATS);
    assert.deepEqual(roomStatsSent(sent), []);
    assert.deepEqual(await invoke('getRoomStats'), ROOM_STATS);

    windowVisibility.show();

    assert.deepEqual(roomStatsSent(sent), [ROOM_STATS]);
});

test('a null after a stop clears the cache', async () => {
    const { session, sent, invoke } = setup();

    session.emit('room-stats', ROOM_STATS);
    session.emit('room-stats', null);

    assert.deepEqual(roomStatsSent(sent), [ROOM_STATS, null]);
    assert.equal(await invoke('getRoomStats'), null);
});

// --- Settings ---

test('getSettings returns the stored settings', async () => {
    const { invoke } = setup();

    assert.deepEqual(await invoke('getSettings'), { geminiApiKey: '', geminiModel: 'gemini-3.5-flash-lite' });
});

test('saveSettings saves the known keys and returns the result', async () => {
    const { invoke, settingsStore } = setup();

    const saved = await invoke('saveSettings', { geminiApiKey: 'abc', geminiModel: 'gemini-2.5-pro' });

    assert.deepEqual(saved, { geminiApiKey: 'abc', geminiModel: 'gemini-2.5-pro' });
    assert.deepEqual(settingsStore.settings, saved);
});

test('saveSettings accepts a partial change', async () => {
    const { invoke } = setup();

    const saved = await invoke('saveSettings', { geminiApiKey: '' });

    assert.equal(saved.geminiApiKey, '');
});

test('saveSettings rejects payloads that are not a plain settings object', async () => {
    const { invoke, settingsStore } = setup();
    const badPayloads = [
        undefined,
        null,
        'geminiApiKey=x',
        ['x'],
        { unknown: 'x' },
        { geminiApiKey: 42 },
        { geminiModel: null },
        { geminiApiKey: 'k'.repeat(201) },
        { geminiModel: 'm'.repeat(101) },
        { geminiModel: 'gemini; rm -rf /' },
    ];

    for (const payload of badPayloads) {
        await assert.rejects(async () => invoke('saveSettings', payload), TypeError, JSON.stringify(payload));
    }
    assert.deepEqual(settingsStore.settings, { geminiApiKey: '', geminiModel: 'gemini-3.5-flash-lite' });
});

test('validateGeminiKey checks a key with Google', async () => {
    const { invoke, keyChecks } = setup();

    assert.equal(await invoke('validateGeminiKey', 'my-key'), 'valid');
    assert.deepEqual(keyChecks, ['my-key']);
});

test('validateGeminiKey rejects a missing, blank or oversized key', async () => {
    const { invoke, keyChecks } = setup();

    for (const key of [undefined, 7, '', '   ', 'k'.repeat(201)]) {
        await assert.rejects(async () => invoke('validateGeminiKey', key), TypeError);
    }
    assert.deepEqual(keyChecks, []);
});

// --- Reset data ---

test('resetData deletes the game data while idle', async () => {
    const { invoke, settingsStore } = setup();

    assert.deepEqual(await invoke('resetData'), { ok: true });
    assert.equal(settingsStore.resetCount, 1);
});

test('resetData refuses while the session is not idle', async () => {
    const { invoke, session, settingsStore } = setup();

    for (const status of ['starting-server', 'starting-tunnel', 'hosting', 'tunnel-restarting', 'stopping']) {
        session.state = snapshot({ status });
        const result = await invoke('resetData');
        assert.equal(result.ok, false, status);
        assert.match(result.error, /Stop hosting/);
    }
    assert.equal(settingsStore.resetCount, 0);
});

test('resetData after a failure tells the user to clear the error first', async () => {
    const { invoke, session, settingsStore } = setup();
    session.state = snapshot({ status: 'failed', error: 'cloudflared exited' });

    const result = await invoke('resetData');

    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error, /Stop hosting/);
    assert.match(result.error, /failed/i);
    assert.equal(settingsStore.resetCount, 0);
});

test('resetData reports a failure to delete as an error result', async () => {
    const { invoke, settingsStore } = setup();
    settingsStore.resetError = new Error('EBUSY: resource busy');

    assert.deepEqual(await invoke('resetData'), { ok: false, error: 'EBUSY: resource busy' });
});

// --- Updates and app info ---

test('checkForUpdate returns the update check result', async () => {
    const { invoke } = setup();

    const result = await invoke('checkForUpdate');

    assert.equal(result.updateAvailable, true);
    assert.equal(result.latestVersion, '1.3.0');
});

test('getAppInfo returns the app version', async () => {
    const { invoke } = setup();

    assert.deepEqual(await invoke('getAppInfo'), { version: '1.2.3' });
});

// --- Power ---

test('getPowerStatus reports whether the laptop is on battery', async () => {
    const { invoke, keepAwake } = setup();
    keepAwake.onBattery = true;

    assert.deepEqual(await invoke('getPowerStatus'), { onBattery: true });
});

test('battery changes are pushed to the renderer', () => {
    const { keepAwake, sent } = setup();

    keepAwake.emitChange(true);

    assert.deepEqual(sent, [{ channel: EVENT_CHANNELS.powerStatus, payload: { onBattery: true } }]);
});

// --- Licence files ---

test('openLicense opens each licence file by name', async () => {
    const { invoke, openedPaths } = setup();

    for (const name of ['app', 'third-party', 'cloudflared']) {
        assert.deepEqual(await invoke('openLicense', name), { ok: true });
    }

    assert.deepEqual(openedPaths, Object.values(LICENSE_PATHS));
});

test('openLicense reports a file the system could not open', async () => {
    const { invoke } = setup({ openPathError: 'Failed to open path' });

    assert.deepEqual(await invoke('openLicense', 'app'), { ok: false, error: "Couldn't open the file: Failed to open path" });
});

test('openLicense rejects anything but a known licence name', async () => {
    const { invoke, openedPaths } = setup();

    for (const name of ['../../etc/passwd', 'toString', '', 42, null]) {
        await assert.rejects(async () => invoke('openLicense', name), TypeError, String(name));
    }
    assert.deepEqual(openedPaths, []);
});

// --- Opening links ---

test('openExternal opens https links', async () => {
    const { invoke, opened } = setup();

    await invoke('openExternal', 'https://aistudio.google.com/apikey');

    assert.deepEqual(opened, ['https://aistudio.google.com/apikey']);
});

test('openExternal opens GitHub release pages and the current tunnel URL', async () => {
    const { invoke, opened, session } = setup();
    session.state = snapshot({ status: 'hosting', url: TUNNEL_URL });

    await invoke('openExternal', 'https://github.com/x/y/releases/tag/v1.3.0');
    await invoke('openExternal', `${TUNNEL_URL}/game`);

    assert.deepEqual(opened, ['https://github.com/x/y/releases/tag/v1.3.0', `${TUNNEL_URL}/game`]);
});

test('openExternal rejects anything but a well-formed https link to a known host', async () => {
    const { invoke, opened, session } = setup();
    session.state = snapshot({ status: 'hosting', url: TUNNEL_URL });
    const badUrls = [
        undefined,
        42,
        '',
        'not a url',
        'http://example.com',
        'http://github.com',
        'file:///C:/Windows/System32/calc.exe',
        'javascript:alert(1)',
        `https://github.com/${'a'.repeat(2048)}`,
        'https://example.com',
        'https://evil.github.com.example.com',
        'https://gist.github.com',
        // A tunnel host that is not the current one.
        'https://other-host.trycloudflare.com',
    ];

    for (const url of badUrls) {
        await assert.rejects(async () => invoke('openExternal', url), TypeError, String(url).slice(0, 40));
    }
    assert.deepEqual(opened, []);
});

test('openGame refuses while there is no tunnel URL', async () => {
    const { invoke, opened } = setup();

    const result = await invoke('openGame');

    assert.equal(result.ok, false);
    assert.match(result.error, /not hosting/i);
    assert.deepEqual(opened, []);
});

test('openGame waits out the DNS delay for a new URL, then opens it', async () => {
    const { invoke, session, opened, sleeps } = setup();
    session.publish({ status: 'hosting', url: TUNNEL_URL });

    assert.deepEqual(await invoke('openGame'), { ok: true });

    assert.deepEqual(sleeps, [OPEN_GAME_DELAY_MS]);
    assert.deepEqual(opened, [TUNNEL_URL]);
});

test('openGame only waits for the part of the delay that has not passed', async () => {
    const { invoke, session, sleeps, advanceTime } = setup();
    session.publish({ status: 'hosting', url: TUNNEL_URL });
    advanceTime(OPEN_GAME_DELAY_MS - 500);

    await invoke('openGame');

    assert.deepEqual(sleeps, [500]);
});

test('openGame opens at once when the URL is older than the delay', async () => {
    const { invoke, session, sleeps, opened, advanceTime } = setup();
    session.publish({ status: 'hosting', url: TUNNEL_URL });
    // Later states with the same URL must not restart the clock.
    advanceTime(OPEN_GAME_DELAY_MS);
    session.publish({ status: 'hosting', url: TUNNEL_URL, serverLog: ['a line'] });

    await invoke('openGame');

    assert.deepEqual(sleeps, []);
    assert.deepEqual(opened, [TUNNEL_URL]);
});

test('openGame restarts the delay when the URL changes', async () => {
    const { invoke, session, sleeps, advanceTime } = setup();
    session.publish({ status: 'hosting', url: TUNNEL_URL });
    advanceTime(OPEN_GAME_DELAY_MS * 2);
    session.publish({ status: 'hosting', url: 'https://new.trycloudflare.com' });

    await invoke('openGame');

    assert.deepEqual(sleeps, [OPEN_GAME_DELAY_MS]);
});

test('openGame does not open a URL that died during the wait', async () => {
    const { session, opened, ipcMain } = setup();
    session.publish({ status: 'hosting', url: TUNNEL_URL });
    // The tunnel restarts while openGame waits for DNS.
    const handler = ipcMain.handlers.get(INVOKE_CHANNELS.openGame);
    const pending = handler(TRUSTED_EVENT);
    session.publish({ status: 'tunnel-restarting', url: null });

    const result = await pending;

    assert.equal(result.ok, false);
    assert.match(result.error, /changed/);
    assert.deepEqual(opened, []);
});

test('openGame uses the real clock and timers by default', async () => {
    const ipcMain = fakeIpcMain();
    const session = new FakeSession();
    const opened = [];
    registerIpcHandlers({
        ipcMain,
        session,
        settingsStore: fakeSettingsStore(),
        keepAwake: fakeKeepAwake(),
        appVersion: '1.0.0',
        openPath: async () => '',
        licensePaths: LICENSE_PATHS,
        checkGeminiKey: async () => 'valid',
        checkForUpdate: async () => ({ updateAvailable: false, latestVersion: null, url: null }),
        openExternal: async (url) => {
            opened.push(url);
        },
        send: () => {},
        isTrustedSender: () => true,
        windowVisibility: fakeWindowVisibility(),
        openGameDelayMs: 5,
    });
    session.publish({ status: 'hosting', url: TUNNEL_URL });

    const result = await ipcMain.handlers.get(INVOKE_CHANNELS.openGame)(TRUSTED_EVENT);

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(opened, [TUNNEL_URL]);
});

// --- Sender check ---

const RENDERER_FILE_URL = 'file:///C:/Apps/Flip7/dist-renderer/index.html';

/** An IPC event from `frameUrl`, in the main frame of `webContents` unless `subFrame` is set. */
function ipcEvent(webContents, frameUrl, { subFrame = false } = {}) {
    const mainFrame = { url: frameUrl };
    webContents.mainFrame = mainFrame;
    let senderFrame = mainFrame;
    if (subFrame) {
        senderFrame = { url: frameUrl };
    }
    return { sender: webContents, senderFrame };
}

test('the sender check accepts the launcher page in the launcher window', () => {
    const webContents = {};
    const isTrusted = createSenderCheck({ getWebContents: () => webContents, rendererFileUrl: RENDERER_FILE_URL });

    assert.equal(isTrusted(ipcEvent(webContents, RENDERER_FILE_URL)), true);
    assert.equal(isTrusted(ipcEvent(webContents, `${RENDERER_FILE_URL}#/settings`)), true);
});

test('the sender check rejects other windows, sub-frames and other pages', () => {
    const webContents = {};
    const isTrusted = createSenderCheck({ getWebContents: () => webContents, rendererFileUrl: RENDERER_FILE_URL });

    assert.equal(isTrusted(ipcEvent({}, RENDERER_FILE_URL)), false, 'another window');
    assert.equal(isTrusted(ipcEvent(webContents, RENDERER_FILE_URL, { subFrame: true })), false, 'a sub-frame');
    assert.equal(isTrusted(ipcEvent(webContents, 'file:///C:/Apps/Flip7/dist-renderer/other.html')), false);
    assert.equal(isTrusted(ipcEvent(webContents, 'https://evil.example.com/')), false);
    assert.equal(isTrusted(ipcEvent(webContents, 'data:text/html,hi')), false);
    assert.equal(isTrusted(ipcEvent(webContents, 'not a url')), false);
    assert.equal(isTrusted({ sender: webContents, senderFrame: null }), false, 'a destroyed frame');
});

test('the sender check rejects everything once the window is gone', () => {
    const webContents = {};
    const isTrusted = createSenderCheck({ getWebContents: () => null, rendererFileUrl: RENDERER_FILE_URL });

    assert.equal(isTrusted(ipcEvent(webContents, RENDERER_FILE_URL)), false);
});

test('with a renderer dev server the sender check accepts only its origin', () => {
    const webContents = {};
    const isTrusted = createSenderCheck({
        getWebContents: () => webContents,
        rendererFileUrl: RENDERER_FILE_URL,
        rendererDevUrl: 'http://localhost:5174',
    });

    assert.equal(isTrusted(ipcEvent(webContents, 'http://localhost:5174/')), true);
    assert.equal(isTrusted(ipcEvent(webContents, 'http://localhost:5174/settings?x=1')), true);
    assert.equal(isTrusted(ipcEvent(webContents, 'http://localhost:5175/')), false);
    assert.equal(isTrusted(ipcEvent(webContents, RENDERER_FILE_URL)), false);
});
