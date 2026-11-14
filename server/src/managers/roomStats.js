import { ConnectionManager } from './ConnectionManager.js';
import { countPeopleOnline } from './onlineSockets.js';
import { SubscriptionManager } from './SubscriptionManager.js';

// The desktop launcher's summary of who is playing (X66), built from the presence cache
// (PresenceManager). Only rooms someone subscribes to are in that cache, so idle rooms are never read.
//
// Players online: distinct emails online in at least one room, by onlineSockets.js's rule (a live
// socket explicitly subscribed to a room they're a player in; admin "*" sockets don't count). A
// room is in play when it isn't closed and at least one of its players is online. Room codes go
// out, never room ids or emails.

const ROOM_STATUS_CLOSED = 'closed';

/**
 * The hub's notification that the stats may have changed, because a room's presence or a GameRoom
 * changed. The hub's `statsEvents` emits it and the LauncherReporter listens for it.
 */
export const STATS_CHANGED = 'statsChanged';

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

// --- Rows --------------------------------------------------------------------

function countOnline(presencePlayers) {
    let online = 0;
    for (const player of presencePlayers) {
        if (player.online) {
            online += 1;
        }
    }
    return online;
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

/** Busiest first; the code breaks ties so equal rooms don't swap places. */
function compareRooms(left, right) {
    if (left.online !== right.online) {
        return right.online - left.online;
    }
    return left.code.localeCompare(right.code);
}

// --- Stats -------------------------------------------------------------------

/**
 * The stats from a presence view.
 *
 * @param {{ getRoom(roomId: string): any,
 *   presence: Iterable<[string, { players: Array<{ online: boolean }> }]>,
 *   playersOnline: number }} view  `getRoom` reads a GameRoom (null when gone), `presence` is
 *   roomId -> cached presence, and `playersOnline` the people online (onlineSockets.js)
 * @returns {RoomStats}
 */
export function summariseRoomStats({ getRoom, presence, playersOnline }) {
    const rooms = [];
    for (const [roomId, roomPresence] of presence) {
        const room = buildRoomStat(getRoom, roomId, roomPresence.players);
        if (room) {
            rooms.push(room);
        }
    }
    rooms.sort(compareRooms);

    return {
        playersOnline,
        roomsLive: rooms.length,
        rooms,
    };
}

/**
 * summariseRoomStats over the hub context's old shape, which roomStats.test builds. Production
 * code calls PresenceManager#buildRoomStats. The plain sockets are read through a
 * ConnectionManager and a SubscriptionManager, so the people online follow the same rule.
 *
 * @param {{ store: { getRecord(entity: string, id: string): any },
 *   presence: Map<string, { players: Array<{ online: boolean }> }>,
 *   wss: { clients: Set<any> } }} context
 * @returns {RoomStats}
 */
export function buildRoomStats(context) {
    const connections = new ConnectionManager({ clients: context.wss.clients });
    const subscriptions = new SubscriptionManager({ connections });
    return summariseRoomStats({
        getRoom: (roomId) => context.store.getRecord('GameRoom', roomId),
        presence: context.presence,
        playersOnline: countPeopleOnline({ connections, subscriptions }),
    });
}
