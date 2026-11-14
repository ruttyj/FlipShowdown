import { CHAT_MESSAGE, PLAYER, ROOM, ROUND_SCORE } from '../domain/entities.js';

// The record-shaped API by entity name: GameRoom, Player, RoundScore and ChatMessage go to their
// own table's repository, and any other entity to RecordRepository, as a JSON row keyed by its
// name. Callers check the name is one they allow (ENTITIES, the game actions) before getting here.
// Both kinds of repository give the same record shape and throw a StoreError for a write the
// database refuses.

export class EntityGateway {
    /**
     * `database` is a Database (the batch insert's transaction runs on it). `rooms`, `players`,
     * `roundScores` and `chatMessages` are the typed tables' repositories; `records` is the
     * RecordRepository every other entity goes to.
     */
    constructor(database, { rooms, players, roundScores, chatMessages, records }) {
        this.database = database;
        this.records = records;
        this.tables = new Map([
            [ROOM, rooms],
            [PLAYER, players],
            [ROUND_SCORE, roundScores],
            [CHAT_MESSAGE, chatMessages],
        ]);
    }

    /** Every record of the entity, oldest first, as `{ seq, record }`. */
    list(entity) {
        const table = this.tables.get(entity);
        if (table) {
            return table.list();
        }
        return this.records.list(entity);
    }

    /** Records whose top-level `field` equals `value`, oldest first. */
    find(entity, field, value) {
        const table = this.tables.get(entity);
        if (table) {
            return table.find(field, value);
        }
        return this.records.find(entity, field, value);
    }

    /**
     * Records whose `email` has this canonical spelling (`email` must already be canonical),
     * oldest first. A typed table matches on its `email` field (a Player's user reference).
     */
    findByEmail(entity, email) {
        const table = this.tables.get(entity);
        if (table) {
            return table.find('email', email);
        }
        return this.records.findByEmail(entity, email);
    }

    /** The record with this id, or null. */
    get(entity, id) {
        const table = this.tables.get(entity);
        if (table) {
            return table.get(id);
        }
        return this.records.get(entity, id);
    }

    /**
     * Inserts every item and returns the new records in the same order. The batch is all or
     * nothing: if one insert throws, none is stored, users created for its players included.
     */
    insertMany(entity, items, createdBy) {
        return this.database.transaction(() => {
            const created = [];
            for (const item of items) {
                created.push(this.insert(entity, item, createdBy));
            }
            return created;
        });
    }

    /** Inserts one item and returns the new record. */
    insert(entity, item, createdBy) {
        const table = this.tables.get(entity);
        if (table) {
            return table.insert(item, createdBy);
        }
        return this.records.insert(entity, item, createdBy);
    }

    /** Shallow-merges `changes` into the record and returns it, or null if there is no such record. */
    update(entity, id, changes) {
        const table = this.tables.get(entity);
        if (table) {
            return table.update(id, changes);
        }
        return this.records.update(entity, id, changes);
    }

    /** Deletes the record and returns it as it was, or null if it didn't exist. */
    delete(entity, id) {
        const table = this.tables.get(entity);
        if (table) {
            return table.delete(id);
        }
        return this.records.delete(entity, id);
    }
}
