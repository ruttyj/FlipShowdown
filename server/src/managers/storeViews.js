// The GameRoom and Player reads and writes the realtime managers are given, shaped like
// RoomRepository's (get) and PlayerRepository's (listByRoom, listByUserEmail, update).

/**
 * GameRoom and Player access over the store. It goes through the store facade at call time, not
 * store.repositories, because some tests wrap facade methods on a running server (see
 * docs/testing.md): entryStatus.test counts store.findRecords lookups.
 *
 * @returns {{ rooms: { get(roomId) }, players: { listByRoom(roomId), listByUserEmail(email),
 *   update(playerId, changes) } }}
 */
export function createStoreViews(store) {
    return {
        rooms: {
            get: (roomId) => store.getRecord('GameRoom', roomId),
        },
        players: {
            listByRoom: (roomId) => store.findRecords('Player', 'room_id', roomId),
            listByUserEmail: (email) => store.findRecordsByEmail('Player', email),
            update: (playerId, changes) => store.updateRecord('Player', playerId, changes),
        },
    };
}
