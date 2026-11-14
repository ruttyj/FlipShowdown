import { translateConstraintErrors } from '../database/entityTables.js';
import { canonicalEmail } from '../lib/email.js';
import { currentTimestamp, generateId, stripServerFields } from './recordFields.js';

// The generic `records` table: entities added through ENTITIES that have no table of their own,
// each record a JSON row keyed by entity name. Every method takes the entity name first. Records
// have the same shape as the typed tables give: client fields, then the server-managed fields.
// Writes the database refuses throw a StoreError.

// --- Rows --------------------------------------------------------------------

/**
 * Turns a records row into the API shape: client fields first, then the server-managed fields
 * (which win over anything stored under the same name).
 */
function rowToRecord(row) {
    return {
        ...JSON.parse(row.data),
        id: row.id,
        created_date: row.created_date,
        updated_date: row.updated_date,
        created_by: row.created_by,
    };
}

function prepareStatements(database) {
    return {
        list: database.prepare('SELECT * FROM records WHERE entity = ? ORDER BY seq'),
        get: database.prepare('SELECT * FROM records WHERE entity = ? AND id = ?'),
        // room_id is the one field with an expression index (records_room_id, migration 0001), and
        // SQLite only uses it when the query spells the path as this literal.
        findByRoomId: database.prepare(
            "SELECT * FROM records WHERE entity = ? AND json_extract(data, '$.room_id') = ? ORDER BY seq",
        ),
        // Unindexed fallback: the path is a parameter, so no index can match it.
        findByPath: database.prepare('SELECT * FROM records WHERE entity = ? AND json_extract(data, ?) = ? ORDER BY seq'),
        insert: database.prepare(
            'INSERT INTO records (entity, id, data, created_date, updated_date, created_by) VALUES (?, ?, ?, ?, ?, ?)',
        ),
        update: database.prepare('UPDATE records SET data = ?, updated_date = ? WHERE entity = ? AND id = ?'),
        remove: database.prepare('DELETE FROM records WHERE entity = ? AND id = ?'),
    };
}

// --- Repository --------------------------------------------------------------

export class RecordRepository {
    /** `database` is a Database (or anything with its `prepare`). */
    constructor(database) {
        this.statements = prepareStatements(database);
    }

    /** Every record of the entity, oldest first, as `{ seq, record }`. */
    list(entity) {
        const rows = this.statements.list.all(entity);
        return rows.map((row) => ({ seq: row.seq, record: rowToRecord(row) }));
    }

    /** Records whose top-level `field` equals `value`, oldest first. */
    find(entity, field, value) {
        let rows;
        if (field === 'room_id') {
            rows = this.statements.findByRoomId.all(entity, value);
        } else {
            rows = this.statements.findByPath.all(entity, `$.${field}`, value);
        }
        return rows.map(rowToRecord);
    }

    /**
     * Records whose `email` has this canonical spelling (`email` must already be canonical), oldest
     * first. Matched in JS with the shared canonicalEmail, because SQLite's lower() only folds
     * ASCII letters.
     */
    findByEmail(entity, email) {
        const records = this.statements.list.all(entity).map(rowToRecord);
        return records.filter((record) => canonicalEmail(record.email) === email);
    }

    /** The record with this id, or null. */
    get(entity, id) {
        const row = this.statements.get.get(entity, id);
        if (!row) {
            return null;
        }
        return rowToRecord(row);
    }

    /**
     * Stores the item without its server-managed fields and returns the new record. `created_by`
     * is `createdBy` exactly as given.
     */
    insert(entity, item, createdBy) {
        return translateConstraintErrors(() => {
            const id = generateId();
            const timestamp = currentTimestamp();
            const data = stripServerFields(item);

            this.statements.insert.run(entity, id, JSON.stringify(data), timestamp, timestamp, createdBy);
            return {
                ...data,
                id,
                created_date: timestamp,
                updated_date: timestamp,
                created_by: createdBy,
            };
        });
    }

    /**
     * Shallow-merges `changes` (without server-managed fields) into the record and returns it, or
     * null if there is no such record. A field set to undefined is dropped, as JSON drops it.
     */
    update(entity, id, changes) {
        return translateConstraintErrors(() => {
            const row = this.statements.get.get(entity, id);
            if (!row) {
                return null;
            }

            const merged = { ...JSON.parse(row.data), ...stripServerFields(changes) };
            this.statements.update.run(JSON.stringify(merged), currentTimestamp(), entity, id);
            return rowToRecord(this.statements.get.get(entity, id));
        });
    }

    /** Deletes the record and returns it as it was, or null if it didn't exist. */
    delete(entity, id) {
        const row = this.statements.get.get(entity, id);
        if (!row) {
            return null;
        }

        this.statements.remove.run(entity, id);
        return rowToRecord(row);
    }
}
