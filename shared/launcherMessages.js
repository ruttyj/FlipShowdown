// Messages the server sends the desktop launcher over Electron's utility-process parent port.
// Not the realtime protocol: phones never see these. The launcher's main process can't import
// this file once packaged (it lives in app.asar, without shared/), so
// desktop/src/main/serverProcess.js keeps a copy that desktop/test/serverProcess.test.js checks.

export const LAUNCHER_MESSAGE = Object.freeze({
    // { type, stats: { playersOnline, roomsLive, rooms: [{ code, status, round, maxScore, online, players }] } }
    ROOM_STATS: 'room-stats',
});
