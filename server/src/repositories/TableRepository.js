import { applyFields, decodeRow, emptyRow, storedRow, translateConstraintErrors } from '../database/entityTables.js';
import { canonicalEmail } from '../lib/email.js';
import { currentTimestamp, generateId, stripServerFields } from './recordFields.js';

// Shared CRUD for one typed table (GameRoom, Player, RoundScore or ChatMessage), described by its
// spec from entityTables.js. Records come back in the API shape decodeRow gives: every declared
// field (null when never set), the fields kept in `extra`, the user reference's email, and the
// server-managed fields. Writes the database refuses throw a StoreError (400 or 409).

// --- Statements --------------------------------------------------------------
// Column names in this SQL come from the spec, never from a request.

/** Every column of the table, joined to the referenced user's email as `user_email`. */
function selectClause(spec) {
    if (!spec.userRef) {
        return `SELECT t.* FROM ${spec.table} t`;
    }
    return `SELECT t.*, u.email AS user_email FROM ${spec.table} t LEFT JOIN users u ON u.id = t.${spec.userRef.column}`;
}

function prepareStatements(database, spec) {
    const select = selectClause(spec);
    const storedColumns = Object.keys(emptyRow(spec).columns);
    const insertColumns = ['id', ...storedColumns, 'extra', 'created_date', 'updated_date', 'created_by'];
    const updateColumns = [...storedColumns, 'extra', 'updated_date'];

    // One find per declared field, so each lookup is a plain indexed (or at least typed) comparison.
    const findByField = new Map();
    for (const field of ['id', ...Object.keys(spec.columns)]) {
        findByField.set(field, database.prepare(`${select} WHERE t.${field} = ? ORDER BY t.seq`));
    }

    let findByUserEmail = null;
    if (spec.userRef) {
        findByUserEmail = database.prepare(`${select} WHERE u.email = ? ORDER BY t.seq`);
    }

    const insertNames = insertColumns.join(', ');
    const insertValues = insertColumns.map((column) => `@${column}`).join(', ');
    const assignments = updateColumns.map((column) => `${column} = @${column}`).join(', ');

    return {
        list: database.prepare(`${select} ORDER BY t.seq`),
        get: database.prepare(`${select} WHERE t.id = ?`),
        findByField,
        findByUserEmail,
        insert: database.prepare(`INSERT INTO ${spec.table} (${insertNames}) VALUES (${insertValues})`),
        update: database.prepare(`UPDATE ${spec.table} SET ${assignments} WHERE id = @id`),
        remove: database.prepare(`DELETE FROM ${spec.table} WHERE id = ?`),
    };
}

// --- Repository --------------------------------------------------------------

export class TableRepository {
    /**
     * `database` is a Database (or anything with its `prepare`), `spec` one entry of ENTITY_TABLES.
     * A table with a user reference also needs `resolveUserId(canonicalEmail)`, which returns the id
     * of that user, creating the user if needed; writes call it to turn the email into a user id.
     */
    constructor(database, spec, { resolveUserId = null } = {}) {
        if (spec.userRef && typeof resolveUserId !== 'function') {
            throw new Error(`The ${spec.table} table has a user reference, so it needs resolveUserId`);
        }

        this.spec = spec;
        this.resolveUserId = resolveUserId;
        this.statements = prepareStatements(database, spec);
    }

    /** The record with this id, or null. */
    get(id) {
        const row = this.statements.get.get(id);
        if (!row) {
            return null;
        }
        return decodeRow(this.spec, row);
    }

    /** Every record, oldest first, as `{ seq, record }` (seq is the table's insertion order). */
    list() {
        const rows = this.statements.list.all();
        return rows.map((row) => ({ seq: row.seq, record: decodeRow(this.spec, row) }));
    }

    /**
     * Records whose `field` equals `value`, oldest first. The user reference field (a Player's
     * email) matches in any spelling. A field with no column is filtered in JS, so any field works.
     */
    find(field, value) {
        const isUserReference = this.spec.userRef !== null && field === this.spec.userRef.field;

        let rows;
        if (isUserReference) {
            rows = this.statements.findByUserEmail.all(canonicalEmail(value));
        } else if (this.statements.findByField.has(field)) {
            rows = this.statements.findByField.get(field).all(value);
        } else {
            const records = this.list().map((entry) => entry.record);
            return records.filter((record) => record[field] === value);
        }
        return rows.map((row) => decodeRow(this.spec, row));
    }

    /**
     * Inserts the record and returns it as a read gives it, so events match later GETs. Run it
     * inside a transaction when a new user it creates must go away if the insert fails.
     */
    insert(item, createdBy) {
        return translateConstraintErrors(() => {
            const id = generateId();
            const timestamp = currentTimestamp();
            const values = this.encodeWrite(emptyRow(this.spec), item);

            this.statements.insert.run({
                ...values,
                id,
                created_date: timestamp,
                updated_date: timestamp,
                created_by: createdBy ?? null,
            });
            return this.get(id);
        });
    }

    /**
     * Shallow-merges `changes` into the record and returns it as a read gives it, or null if there
     * is no such record. A field set to undefined is cleared.
     */
    update(id, changes) {
        return translateConstraintErrors(() => {
            const row = this.statements.get.get(id);
            if (!row) {
                return null;
            }

            const values = this.encodeWrite(storedRow(this.spec, row), changes);
            this.statements.update.run({ ...values, id, updated_date: currentTimestamp() });
            return this.get(id);
        });
    }

    /** Deletes the record (the foreign keys cascade to its children) and returns it as it was. */
    delete(id) {
        const record = this.get(id);
        if (!record) {
            return null;
        }

        this.statements.remove.run(id);
        return record;
    }

    /**
     * The row's columns ready to write: applyFields' result with its user reference turned into a
     * user id. Throws a StoreError for a value of the wrong type.
     */
    encodeWrite(row, fields) {
        const written = applyFields(this.spec, row, stripServerFields(fields));
        const columns = { ...written.columns };
        if (written.userEmail !== undefined) {
            let userId = null;
            if (written.userEmail !== null) {
                userId = this.resolveUserId(written.userEmail);
            }
            columns[this.spec.userRef.column] = userId;
        }
        return { ...columns, extra: JSON.stringify(written.extra) };
    }
}
