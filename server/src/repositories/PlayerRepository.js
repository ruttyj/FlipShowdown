import { ENTITY_TABLES } from '../database/entityTables.js';
import { PLAYER } from '../domain/entities.js';
import { TableRepository } from './TableRepository.js';

// The players table. get, insert, update and delete come from TableRepository; this class adds
// the named reads the game and realtime code need. Records have the store's Player shape, with
// `email` taken from the user the row points at, so it is always canonical.

/** Turn order, with a player that has none counted as 0, as the game code has always sorted. */
function byTurnOrder(left, right) {
    return (left.turn_order ?? 0) - (right.turn_order ?? 0);
}

export class PlayerRepository extends TableRepository {
    /**
     * `resolveUserId(canonicalEmail)` returns the id of the user with that email, creating the
     * user if needed (UserRepository#resolveId). Inserts and email changes call it, so run them
     * inside a transaction when a user it creates must go away if the write fails.
     */
    constructor(database, { resolveUserId } = {}) {
        super(database, ENTITY_TABLES.get(PLAYER), { resolveUserId });
    }

    /** The room's players in the order they joined (oldest first). */
    listByRoom(roomId) {
        return this.find('room_id', roomId);
    }

    /**
     * The room's players sorted by turn_order, joining order breaking ties (the sort is stable).
     * Sorted in JS rather than SQL so a legacy turn_order kept in `extra` sorts as it always has.
     */
    listByRoomInTurnOrder(roomId) {
        return this.listByRoom(roomId).sort(byTurnOrder);
    }

    /** Every player of the user with this email (any spelling), across all rooms, oldest first. */
    listByUserEmail(email) {
        return this.find('email', email);
    }
}
