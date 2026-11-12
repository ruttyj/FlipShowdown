// What the room page's auto-join needs: the name to join under, and a per-room flag that
// remembers I was kicked or left on purpose, so reopening the room doesn't put me straight
// back in (decision X3). The flag lives in localStorage, keyed by room code with the room id
// as its value (X3b), and is cleared by the next successful join.

import { readLocalJson, removeLocal, writeLocalJson } from './safeStorage.js';

const LEFT_ROOM_KEY_PREFIX = 'flip7_left_room_';

// --- Player name -------------------------------------------------------------

/**
 * The name a new player gets: my account name, else the start of my email. A name of only
 * spaces counts as no name, since the server rejects a blank one.
 */
export function defaultPlayerName(user) {
    const hasFullName = Boolean(user.full_name) && user.full_name.trim() !== '';
    if (hasFullName) {
        return user.full_name;
    }
    return user.email.split('@')[0];
}

// --- Left-room flag ----------------------------------------------------------
// The flag's value is the id of the room I left. Codes are reused once a room closes, so a
// new room with the same code doesn't match and auto-joins as usual (X3b).

/** Room codes are matched like the server's lookup does: trimmed and upper-cased. */
function leftRoomKey(roomCode) {
    return LEFT_ROOM_KEY_PREFIX + String(roomCode).trim().toUpperCase();
}

/**
 * Remembers that I was kicked from, or left, the room with this code and id. Does nothing
 * without both.
 */
export function rememberLeftRoom(roomCode, roomId) {
    if (!roomCode || !roomId) {
        return;
    }
    writeLocalJson(leftRoomKey(roomCode), roomId);
}

/**
 * True when I was kicked from, or left, this very room (same code and id) and haven't
 * joined it since.
 */
export function hasLeftRoom(roomCode, roomId) {
    if (!roomCode || !roomId) {
        return false;
    }
    return readLocalJson(leftRoomKey(roomCode), null) === roomId;
}

/** Clears the flag after I joined the room again. */
export function forgetLeftRoom(roomCode) {
    if (!roomCode) {
        return;
    }
    removeLocal(leftRoomKey(roomCode));
}
