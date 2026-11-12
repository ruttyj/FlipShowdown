// Where a room lives in the app: /room/<code>, e.g. /room/3Z7R7L.

/** The react-router path for the room page. */
export const ROOM_ROUTE = '/room/:code';

// One path segment after /room/, with an optional trailing slash: "/room/3Z7R7L/" -> "3Z7R7L".
const ROOM_PATH_PATTERN = /^\/room\/([^/]+)\/?$/;

/** The app path for a room: "3Z7R7L" -> "/room/3Z7R7L". */
export function roomPath(code) {
    return `/room/${encodeURIComponent(code)}`;
}

/**
 * The room code in a pathname, or null when the pathname isn't a room page
 * (or its code is a malformed escape such as "%E0%A4%A").
 */
export function readRoomCode(pathname) {
    const match = ROOM_PATH_PATTERN.exec(pathname);
    if (!match) {
        return null;
    }

    try {
        return decodeURIComponent(match[1]);
    } catch {
        return null;
    }
}
