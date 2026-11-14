// The desktop launcher's summary of who is playing (X66), built from the presence cache
// (PresenceManager). Only rooms someone subscribes to are in that cache, so idle rooms are never read.
//
// Players online: distinct emails with a live socket explicitly subscribed to a room they're a
// player in. Admin "*" sockets don't count. A room is in play when it isn't closed and at least
// one of its players is online. Room codes go out, never room ids or emails.

const ROOM_STATUS_CLOSED = 'closed';

/**
 * @typedef {object} RoomStat
 * @property {string} code
 * @property {'waiting' | 'playing' | 'finished'} status
 * @property {number} round
 * @property {number} maxScore
 * @property {number} online   the room's players who are online
 * @property {number} players  everyone in the room
 */

/**
 * @typedef {object} RoomStats
 * @property {number} playersOnline
 * @property {number} roomsLive
 * @property {RoomStat[]} rooms  busiest first
 */

/**
 * The stats from a presence view.
 *
 * @param {{ getRoom(roomId: string): any,
 *   presence: Iterable<[string, { players: Array<{ online: boolean }> }]>,
 *   clients: Iterable<any> }} view  `getRoom` reads a GameRoom (null when gone), `presence` is
 *   roomId -> cached presence, and `clients` every realtime socket
 * @returns {RoomStats}
 */
export function summariseRoomStats({ getRoom, presence, clients }) {
    const rooms = [];
    for (const [roomId, roomPresence] of presence) {
        const room = buildRoomStat(getRoom, roomId, roomPresence.players);
        if (room) {
            rooms.push(room);
        }
    }
    rooms.sort(compareRooms);

    return {
        playersOnline: countPeopleOnline(clients),
        roomsLive: rooms.length,
        rooms,
    };
}

/**
 * summariseRoomStats over the hub context's old shape, which roomStats.test builds. Production
 * code calls summariseRoomStats (PresenceManager#buildRoomStats).
 *
 * @param {{ store: { getRecord(entity: string, id: string): any },
 *   presence: Map<string, { players: Array<{ online: boolean }> }>,
 *   wss: { clients: Iterable<any> } }} context
 * @returns {RoomStats}
 */
export function buildRoomStats(context) {
    return summariseRoomStats({
        getRoom: (roomId) => context.store.getRecord('GameRoom', roomId),
        presence: context.presence,
        clients: context.wss.clients,
    });
}

/** One room's row, or null when nobody in it is online or it has closed. */
function buildRoomStat(getRoom, roomId, presencePlayers) {
    const online = countOnline(presencePlayers);
    if (online === 0) {
        return null;
    }

    const room = getRoom(roomId);
    if (!room || room.status === ROOM_STATUS_CLOSED) {
        return null;
    }

    return {
        code: room.code,
        status: room.status,
        round: room.current_round,
        maxScore: room.max_score,
        online,
        players: presencePlayers.length,
    };
}

function countOnline(presencePlayers) {
    let online = 0;
    for (const player of presencePlayers) {
        if (player.online) {
            online += 1;
        }
    }
    return online;
}

/**
 * People, not tabs: one email with a phone and a laptop open counts once. Like presence, only
 * explicit room subscriptions count, so admin "*" sockets don't. It reads the per-socket fields
 * ConnectionManager (isLive) and SubscriptionManager (isSubscribed, rooms) keep, because
 * roomStats.test hands it plain socket objects.
 */
function countPeopleOnline(sockets) {
    const emails = new Set();
    for (const socket of sockets) {
        const isPlaying = socket.isSubscribed
            && socket.isLive
            && socket.rooms.size > 0;
        if (isPlaying) {
            emails.add(socket.identity.email);
        }
    }
    return emails.size;
}

/** Busiest first; the code breaks ties so equal rooms don't swap places. */
function compareRooms(left, right) {
    if (left.online !== right.online) {
        return right.online - left.online;
    }
    return left.code.localeCompare(right.code);
}
