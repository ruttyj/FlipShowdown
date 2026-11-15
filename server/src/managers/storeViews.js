// The GameRoom and Player reads and writes the realtime managers are given, shaped like
// RoomRepository's (get) and PlayerRepository's (listByRoom, listByUserEmail, update).

/**
 * GameRoom and Player access over the store's repositories. The one exception is
 * players.listByRoom, which goes through the store facade at call time: entryStatus.test counts
 * store.findRecords lookups on a running server (see docs/testing.md).
 *
 * @returns {{ rooms: { get(roomId) }, players: { listByRoom(roomId), listByUserEmail(email),
 *   update(playerId, changes) } }}
 */
export function createStoreViews(store) {
    const { rooms, players } = store.repositories;
    return {
        rooms: {
            get: (roomId) => rooms.get(roomId),
        },
        players: {
            listByRoom: (roomId) => store.findRecords('Player', 'room_id', roomId),
            listByUserEmail: (email) => players.listByUserEmail(email),
            update: (playerId, changes) => players.update(playerId, changes),
        },
    };
}
