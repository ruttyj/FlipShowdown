// The Rooms panel's list logic (X66): which rows to draw, holding their order still, how a
// room's stage reads and its join link. Pure, so it is tested without React.

/** @typedef {import('../shared/launcherBridge').RoomStat} RoomStat */

export const COLLAPSED_ROOM_ROWS = 5;
export const FILTER_FROM_ROOMS = 10;

/**
 * The rows to draw. Collapsed: the first COLLAPSED_ROOM_ROWS. Expanded: every room whose code
 * contains the filter (any case, spaces ignored), in the order given.
 * @param {RoomStat[]} rooms
 * @param {{ isExpanded: boolean, filter: string }} view
 * @returns {RoomStat[]}
 */
export function visibleRooms(rooms, { isExpanded, filter }) {
    if (!isExpanded) {
        return rooms.slice(0, COLLAPSED_ROOM_ROWS);
    }

    const wanted = filter.replace(/\s/g, '').toUpperCase();
    if (wanted === '') {
        return rooms;
    }
    return rooms.filter((room) => room.code.includes(wanted));
}

/**
 * Puts `rooms` back in `previousCodes`' order, so rows don't move while the pointer is over the
 * list. Rooms that left are dropped; new rooms go at the end in their own order.
 * @param {string[]} previousCodes
 * @param {RoomStat[]} rooms
 * @returns {RoomStat[]}
 */
export function keepOrder(previousCodes, rooms) {
    const byCode = new Map(rooms.map((room) => [room.code, room]));
    const ordered = [];
    for (const code of previousCodes) {
        const room = byCode.get(code);
        if (room) {
            ordered.push(room);
            byCode.delete(code);
        }
    }
    for (const room of byCode.values()) {
        ordered.push(room);
    }
    return ordered;
}

/**
 * What a room is up to, in the words the room screens use: "In the lobby", "Round 4 · to 200",
 * "Game over · to 200".
 * @param {RoomStat} room
 */
export function describeStage(room) {
    if (room.status === 'waiting') {
        return 'In the lobby';
    }
    if (room.status === 'finished') {
        return `Game over · to ${room.maxScore}`;
    }
    return `Round ${room.round} · to ${room.maxScore}`;
}

/**
 * The link the lobby's own QR code uses, on the current game link:
 * "https://x.trycloudflare.com" + "FW6XK6" -> "https://x.trycloudflare.com/room/FW6XK6"
 * @param {string} gameUrl
 * @param {string} code
 */
export function roomJoinUrl(gameUrl, code) {
    return new URL(`/room/${encodeURIComponent(code)}`, gameUrl).toString();
}
