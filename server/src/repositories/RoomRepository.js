import { ENTITY_TABLES } from '../database/entityTables.js';
import { TableRepository } from './TableRepository.js';

// The `game_rooms` table (entity GameRoom). Records have the shape TableRepository gives, with the
// host's canonical email as `host_email`. Besides the inherited get, list, find, insert, update and
// delete, it has the named lookups the game code needs.

/** When the room was last touched in ms: its last action, or its creation when it has none yet. */
function lastTouchedMs(room) {
    const lastTouched = room.last_activity_date || room.created_date;
    return new Date(lastTouched).getTime();
}

export class RoomRepository extends TableRepository {
    /**
     * `database` is a Database. `resolveUserId(email)` returns the id of the user with that email,
     * creating the user if needed (UserRepository#resolveId); writes use it for `host_email`.
     */
    constructor(database, { resolveUserId }) {
        super(database, ENTITY_TABLES.get('GameRoom'), { resolveUserId });
        this.database = database;
    }

    /**
     * Rooms with this join code, oldest first. Closed rooms keep their code, so there can be
     * several; at most one of them is open (the game_rooms_open_code index).
     */
    findByCode(code) {
        return this.find('code', code);
    }

    /**
     * Rooms last touched (last_activity_date, or created_date when that is unset) before
     * `cutoffMs`, a time in ms, oldest first. A date that doesn't parse never counts as idle.
     */
    listIdle(cutoffMs) {
        const idleRooms = [];
        for (const { record: room } of this.list()) {
            if (lastTouchedMs(room) < cutoffMs) {
                idleRooms.push(room);
            }
        }
        return idleRooms;
    }

    /**
     * Inserts the room (see TableRepository#insert). Atomic: a host user created for it goes away if
     * the insert fails. Inside another transaction it is a savepoint of that one.
     */
    insert(item, createdBy) {
        return this.database.transaction(() => super.insert(item, createdBy));
    }

    /**
     * Updates the room (see TableRepository#update). Atomic like insert, so a host user created for
     * the update goes away if it fails.
     */
    update(id, changes) {
        return this.database.transaction(() => super.update(id, changes));
    }
}
