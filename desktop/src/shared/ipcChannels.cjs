// The launcher's IPC channel names, used by the main process (ipc.js) and the tests. The
// sandboxed preload can't require this file, so it keeps a copy; test/preload.test.js checks
// that the copy matches. CommonJS, like the preload it mirrors; main imports it as an ES module.

/** Renderer -> main requests, answered through ipcMain.handle / ipcRenderer.invoke. */
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

/** Main -> renderer pushes, sent with webContents.send and received with ipcRenderer.on. */
const EVENT_CHANNELS = Object.freeze({
    state: 'launcher:state',
    urlChanged: 'launcher:url-changed',
    powerStatus: 'launcher:power-status',
    roomStats: 'launcher:room-stats',
});

module.exports = { INVOKE_CHANNELS, EVENT_CHANNELS };
