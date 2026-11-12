// Exposes window.launcher (the LauncherBridge in src/shared/launcherBridge.d.ts) to the
// launcher page. Nothing else from Electron or Node reaches the page.
//
// The window runs sandboxed, and a sandboxed preload can only require 'electron' and a few
// built-ins. So the channel names are copied here rather than required from
// src/shared/ipcChannels.cjs; test/preload.test.js checks the two lists match.
const { contextBridge, ipcRenderer } = require('electron');

/** Renderer -> main requests. Must equal INVOKE_CHANNELS in src/shared/ipcChannels.cjs. */
const INVOKE_CHANNELS = Object.freeze({
    start: 'launcher:start',
    stop: 'launcher:stop',
    retry: 'launcher:retry',
    getState: 'launcher:get-state',
    getRoomStats: 'launcher:get-room-stats',
    getSettings: 'launcher:get-settings',
    saveSettings: 'launcher:save-settings',
    validateGeminiKey: 'launcher:validate-gemini-key',
    resetData: 'launcher:reset-data',
    checkForUpdate: 'launcher:check-for-update',
    openExternal: 'launcher:open-external',
    openGame: 'launcher:open-game',
    openLicense: 'launcher:open-license',
    getPowerStatus: 'launcher:get-power-status',
    getAppInfo: 'launcher:get-app-info',
});

/** Main -> renderer pushes. Must equal EVENT_CHANNELS in src/shared/ipcChannels.cjs. */
const EVENT_CHANNELS = Object.freeze({
    state: 'launcher:state',
    urlChanged: 'launcher:url-changed',
    powerStatus: 'launcher:power-status',
    roomStats: 'launcher:room-stats',
});

/**
 * Subscribes `callback` to a main-process push and returns the unsubscribe function. The
 * Electron event object is dropped so the page never sees `sender`.
 * @param {string} channel
 * @param {(payload: any) => void} callback
 * @returns {() => void}
 */
function subscribe(channel, callback) {
    if (typeof callback !== 'function') {
        throw new TypeError('callback must be a function');
    }

    /** @type {(event: unknown, payload: any) => void} */
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => {
        ipcRenderer.removeListener(channel, listener);
    };
}

// Typed so `npm run typecheck` fails when this object and the LauncherBridge interface drift.
/** @type {import('../shared/launcherBridge').LauncherBridge} */
const bridge = {
    start: () => ipcRenderer.invoke(INVOKE_CHANNELS.start),
    stop: () => ipcRenderer.invoke(INVOKE_CHANNELS.stop),
    retry: () => ipcRenderer.invoke(INVOKE_CHANNELS.retry),
    getState: () => ipcRenderer.invoke(INVOKE_CHANNELS.getState),
    onState: (callback) => subscribe(EVENT_CHANNELS.state, callback),
    onUrlChanged: (callback) => subscribe(EVENT_CHANNELS.urlChanged, callback),
    getRoomStats: () => ipcRenderer.invoke(INVOKE_CHANNELS.getRoomStats),
    onRoomStats: (callback) => subscribe(EVENT_CHANNELS.roomStats, callback),
    getSettings: () => ipcRenderer.invoke(INVOKE_CHANNELS.getSettings),
    saveSettings: (changes) => ipcRenderer.invoke(INVOKE_CHANNELS.saveSettings, changes),
    validateGeminiKey: (key) => ipcRenderer.invoke(INVOKE_CHANNELS.validateGeminiKey, key),
    resetData: () => ipcRenderer.invoke(INVOKE_CHANNELS.resetData),
    checkForUpdate: () => ipcRenderer.invoke(INVOKE_CHANNELS.checkForUpdate),
    openExternal: (url) => ipcRenderer.invoke(INVOKE_CHANNELS.openExternal, url),
    openGame: () => ipcRenderer.invoke(INVOKE_CHANNELS.openGame),
    openLicense: (name) => ipcRenderer.invoke(INVOKE_CHANNELS.openLicense, name),
    getPowerStatus: () => ipcRenderer.invoke(INVOKE_CHANNELS.getPowerStatus),
    onPowerStatus: (callback) => subscribe(EVENT_CHANNELS.powerStatus, callback),
    getAppInfo: () => ipcRenderer.invoke(INVOKE_CHANNELS.getAppInfo),
};

contextBridge.exposeInMainWorld('launcher', bridge);
