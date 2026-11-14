// The desktop launcher's summary of who is playing (X66), built from the realtime hub's presence
// map. Only rooms someone subscribes to are in that map, so idle rooms are never read.
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
 * @param {{ store: { getRecord(entity: string, id: string): any },
 *   presence: Map<string, { players: Array<{ online: boolean }> }>,
 *   wss: { clients: Iterable<any> } }} context  the hub's context
 * @returns {RoomStats}
 */
export function buildRoomStats(context) {
    const rooms = [];
    for (const [roomId, presence] of context.presence) {
        const room = buildRoomStat(context.store, roomId, presence.players);
        if (room) {
            rooms.push(room);
        }
    }
    rooms.sort(compareRooms);

    return {
        playersOnline: countPeopleOnline(context.wss.clients),
        roomsLive: rooms.length,
        rooms,
    };
}

/** One room's row, or null when nobody in it is online or it has closed. */
function buildRoomStat(store, roomId, presencePlayers) {
    const online = countOnline(presencePlayers);
    if (online === 0) {
        return null;
    }

    const room = store.getRecord('GameRoom', roomId);
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
 * People, not tabs: one email with a phone and a laptop open counts once. Like onlineEmails() in
 * realtime.js, only explicit room subscriptions count, so admin "*" sockets don't.
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
