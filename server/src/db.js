import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { backupsDir } from './backup.js';
import { DATABASE_FILE } from './config.js';
import { canonicalEmail } from './email.js';
import { ENTITY_TABLES, applyFields, decodeRow, emptyRow, storedRow, toStoreError } from './entityTables.js';
import { createEventLog } from './eventLog.js';
import { runMigrations } from './migrate.js';
import { MIGRATIONS } from './migrations/index.js';

// Fields the server owns; whatever the client sends for these is discarded.
export const SERVER_MANAGED_FIELDS = ['id', 'created_date', 'updated_date', 'created_by'];

// --- Helpers -------------------------------------------------------------

/** 24 lowercase hex chars (Mongo-style ids). */
export function generateId() {
    return crypto.randomBytes(12).toString('hex');
}

function now() {
    return new Date().toISOString();
}

/** Returns a copy of client input without the server-managed fields. */
export function stripServerFields(input) {
    // Spread defines own properties, so a "__proto__" key stays plain data.
    const clean = { ...input };
    for (const field of SERVER_MANAGED_FIELDS) {
        delete clean[field];
    }
    return clean;
}

/** Runs `write` and turns a SQLite constraint violation into a StoreError (see entityTables.js). */
function translateConstraintErrors(write) {
    try {
        return write();
    } catch (error) {
        throw toStoreError(error);
    }
}

// --- Users ---------------------------------------------------------------

function prepareUserStatements(db) {
    return {
        findUser: db.prepare('SELECT * FROM users WHERE email = ?'),
        insertUser: db.prepare(
            'INSERT INTO users (id, email, full_name, created_date, updated_date) VALUES (?, ?, ?, ?, ?)',
        ),
        updateUserName: db.prepare('UPDATE users SET full_name = ?, updated_date = ? WHERE email = ?'),
    };
}

/**
 * The id of the user with this canonical email. Someone seated before they ever signed in (by an
 * admin, the generic API or a test) gets a user with no name, which their first sign-in completes.
 */
function resolveUserId(users, email) {
    const existing = users.findUser.get(email);
    if (existing) {
        return existing.id;
    }

    const id = generateId();
    const timestamp = now();
    users.insertUser.run(id, email, null, timestamp, timestamp);
    return id;
}

// --- Generic records table (entities added through ENTITIES) -------------

/**
 * Turns a records row into the API shape: client fields first, then the
 * server-managed fields (which win over anything stored under the same name).
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

function prepareRecordStatements(db) {
    return {
        listRecords: db.prepare('SELECT * FROM records WHERE entity = ? ORDER BY seq'),
        getRecord: db.prepare('SELECT * FROM records WHERE entity = ? AND id = ?'),
        // room_id is the one field with an expression index (records_room_id, migration 0001).
        findByRoomId: db.prepare(
            "SELECT * FROM records WHERE entity = ? AND json_extract(data, '$.room_id') = ? ORDER BY seq",
        ),
        // Unindexed fallback: the path is a parameter, so no index can match it.
        findRecords: db.prepare('SELECT * FROM records WHERE entity = ? AND json_extract(data, ?) = ? ORDER BY seq'),
        insertRecord: db.prepare(
            'INSERT INTO records (entity, id, data, created_date, updated_date, created_by) VALUES (?, ?, ?, ?, ?, ?)',
        ),
        updateRecord: db.prepare('UPDATE records SET data = ?, updated_date = ? WHERE entity = ? AND id = ?'),
        deleteRecord: db.prepare('DELETE FROM records WHERE entity = ? AND id = ?'),
    };
}

function findGenericRecords(statements, entity, field, value) {
    let rows;
    if (field === 'room_id') {
        rows = statements.findByRoomId.all(entity, value);
    } else {
        rows = statements.findRecords.all(entity, `$.${field}`, value);
    }
    return rows.map(rowToRecord);
}

/**
 * Records whose `email` has this canonical spelling, oldest first. Matched in JS with the shared
 * canonicalEmail, because SQLite's lower() only folds ASCII letters.
 */
function findGenericRecordsByEmail(statements, entity, email) {
    const records = statements.listRecords.all(entity).map(rowToRecord);
    return records.filter((record) => canonicalEmail(record.email) === email);
}

function insertGenericRecord(statements, entity, item, createdBy) {
    const id = generateId();
    const timestamp = now();
    const data = stripServerFields(item);

    statements.insertRecord.run(entity, id, JSON.stringify(data), timestamp, timestamp, createdBy);
    return {
        ...data,
        id,
        created_date: timestamp,
        updated_date: timestamp,
        created_by: createdBy,
    };
}

function updateGenericRecord(statements, entity, id, changes) {
    const row = statements.getRecord.get(entity, id);
    if (!row) {
        return null;
    }

    const merged = { ...JSON.parse(row.data), ...stripServerFields(changes) };
    statements.updateRecord.run(JSON.stringify(merged), now(), entity, id);
    return rowToRecord(statements.getRecord.get(entity, id));
}

function deleteGenericRecord(statements, entity, id) {
    const row = statements.getRecord.get(entity, id);
    if (!row) {
        return null;
    }

    statements.deleteRecord.run(entity, id);
    return rowToRecord(row);
}

/** The store operations for one entity kept in `records`. */
function genericBackend(statements, entity) {
    return {
        list: () => statements.listRecords.all(entity).map((row) => ({ seq: row.seq, record: rowToRecord(row) })),
        find: (field, value) => findGenericRecords(statements, entity, field, value),
        findByEmail: (email) => findGenericRecordsByEmail(statements, entity, email),
        get: (id) => {
            const row = statements.getRecord.get(entity, id);
            return row ? rowToRecord(row) : null;
        },
        insert: (item, createdBy) => insertGenericRecord(statements, entity, item, createdBy),
        update: (id, changes) => updateGenericRecord(statements, entity, id, changes),
        remove: (id) => deleteGenericRecord(statements, entity, id),
    };
}

// --- Typed tables (GameRoom, Player, RoundScore, ChatMessage) ------------
// Column names in this SQL come from the specs in entityTables.js, never from a request.

/** Every column of the table, joined to the referenced user's email as `user_email`. */
function selectClause(spec) {
    if (!spec.userRef) {
        return `SELECT t.* FROM ${spec.table} t`;
    }
    return `SELECT t.*, u.email AS user_email FROM ${spec.table} t LEFT JOIN users u ON u.id = t.${spec.userRef.column}`;
}

function prepareTableStatements(db, spec) {
    const select = selectClause(spec);
    const storedColumns = Object.keys(emptyRow(spec).columns);
    const insertColumns = ['id', ...storedColumns, 'extra', 'created_date', 'updated_date', 'created_by'];
    const updateColumns = [...storedColumns, 'extra', 'updated_date'];

    // One find per declared field, so each lookup is a plain indexed (or at least typed) comparison.
    const findByField = new Map();
    for (const field of ['id', ...Object.keys(spec.columns)]) {
        findByField.set(field, db.prepare(`${select} WHERE t.${field} = ? ORDER BY t.seq`));
    }

    let findByUserEmail = null;
    if (spec.userRef) {
        findByUserEmail = db.prepare(`${select} WHERE u.email = ? ORDER BY t.seq`);
    }

    const insertNames = insertColumns.join(', ');
    const insertValues = insertColumns.map((column) => `@${column}`).join(', ');
    const assignments = updateColumns.map((column) => `${column} = @${column}`).join(', ');

    return {
        list: db.prepare(`${select} ORDER BY t.seq`),
        get: db.prepare(`${select} WHERE t.id = ?`),
        findByField,
        findByUserEmail,
        insert: db.prepare(`INSERT INTO ${spec.table} (${insertNames}) VALUES (${insertValues})`),
        update: db.prepare(`UPDATE ${spec.table} SET ${assignments} WHERE id = @id`),
        remove: db.prepare(`DELETE FROM ${spec.table} WHERE id = ?`),
    };
}

/** table = { spec, statements, users } */
function getTableRecord(table, id) {
    const row = table.statements.get.get(id);
    if (!row) {
        return null;
    }
    return decodeRow(table.spec, row);
}

function listTableRecords(table) {
    const rows = table.statements.list.all();
    return rows.map((row) => ({ seq: row.seq, record: decodeRow(table.spec, row) }));
}

/**
 * Records whose `field` equals `value`, oldest first. The user reference field (a Player's
 * email) matches in any spelling. A field with no column is filtered in JS, so any field works.
 */
function findTableRecords(table, field, value) {
    const { spec, statements } = table;
    const isUserReference = spec.userRef !== null && field === spec.userRef.field;

    let rows;
    if (isUserReference) {
        rows = statements.findByUserEmail.all(canonicalEmail(value));
    } else if (statements.findByField.has(field)) {
        rows = statements.findByField.get(field).all(value);
    } else {
        const records = listTableRecords(table).map((entry) => entry.record);
        return records.filter((record) => record[field] === value);
    }
    return rows.map((row) => decodeRow(spec, row));
}

/**
 * The row's columns ready to write: applyFields' result with its user reference turned into a
 * user id. Throws a StoreError for a value of the wrong type.
 */
function encodeWrite(table, row, fields) {
    const written = applyFields(table.spec, row, stripServerFields(fields));
    const columns = { ...written.columns };
    if (written.userEmail !== undefined) {
        let userId = null;
        if (written.userEmail !== null) {
            userId = resolveUserId(table.users, written.userEmail);
        }
        columns[table.spec.userRef.column] = userId;
    }
    return { ...columns, extra: JSON.stringify(written.extra) };
}

/** Inserts the record and returns it as a read gives it, so events match later GETs. */
function insertTableRecord(table, item, createdBy) {
    const id = generateId();
    const timestamp = now();
    const values = encodeWrite(table, emptyRow(table.spec), item);

    table.statements.insert.run({
        ...values,
        id,
        created_date: timestamp,
        updated_date: timestamp,
        created_by: createdBy ?? null,
    });
    return getTableRecord(table, id);
}

/** Shallow-merges `changes` into the record; a field set to undefined is cleared. */
function updateTableRecord(table, id, changes) {
    const row = table.statements.get.get(id);
    if (!row) {
        return null;
    }

    const values = encodeWrite(table, storedRow(table.spec, row), changes);
    table.statements.update.run({ ...values, id, updated_date: now() });
    return getTableRecord(table, id);
}

/** Deletes the record (the foreign keys cascade to its children) and returns it as it was. */
function deleteTableRecord(table, id) {
    const record = getTableRecord(table, id);
    if (!record) {
        return null;
    }

    table.statements.remove.run(id);
    return record;
}

/** The store operations for one entity with its own table. */
function tableBackend(table) {
    return {
        list: () => listTableRecords(table),
        find: (field, value) => findTableRecords(table, field, value),
        findByEmail: (email) => findTableRecords(table, 'email', email),
        get: (id) => getTableRecord(table, id),
        insert: (item, createdBy) => insertTableRecord(table, item, createdBy),
        update: (id, changes) => updateTableRecord(table, id, changes),
        remove: (id) => deleteTableRecord(table, id),
    };
}

/** Entity name -> backend for the four entities that have their own table. */
function createTableBackends(db, users) {
    const backends = new Map();
    for (const [entity, spec] of ENTITY_TABLES) {
        const statements = prepareTableStatements(db, spec);
        backends.set(entity, tableBackend({ spec, statements, users }));
    }
    return backends;
}

// --- Store ---------------------------------------------------------------

/**
 * Opens (creating if needed) DATA_DIR/flip7.db and brings its schema up to date (see migrate.js).
 * Before migrating a database that holds data, it saves a copy in DATA_DIR/backups. Returns the
 * connection, with foreign keys enforced.
 */
export function openDatabase(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });

    const db = new Database(path.join(dataDir, DATABASE_FILE));
    try {
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        runMigrations(db, MIGRATIONS, { snapshotDir: backupsDir(dataDir) });
        db.pragma('foreign_keys = ON');
    } catch (error) {
        // Release the file, so the caller (or a test's cleanup) can move or delete it.
        db.close();
        throw error;
    }
    return db;
}

/**
 * Opens the database (see openDatabase) and returns a small store API.
 * All methods are synchronous, so each request's write is atomic.
 * GameRoom, Player, RoundScore and ChatMessage live in their own tables (see entityTables.js);
 * any other entity is a JSON row in `records`. Both give the same record shape.
 * Writes the database refuses throw a StoreError (400 or 409).
 * `eventLogLimit` overrides how many realtime events are kept (tests).
 */
export function openStore(dataDir, { eventLogLimit } = {}) {
    const db = openDatabase(dataDir);

    const users = prepareUserStatements(db);
    const recordStatements = prepareRecordStatements(db);
    const tableBackends = createTableBackends(db, users);

    function backendFor(entity) {
        return tableBackends.get(entity) ?? genericBackend(recordStatements, entity);
    }

    // The whole batch is all-or-nothing, users created for its players included.
    const insertMany = db.transaction((entity, items, createdBy) => {
        const backend = backendFor(entity);
        const records = [];
        for (const item of items) {
            records.push(backend.insert(item, createdBy));
        }
        return records;
    });

    // A transaction too, so a user created for the update goes away if the update fails.
    const updateOne = db.transaction((entity, id, changes) => backendFor(entity).update(id, changes));

    return {
        eventLog: createEventLog(db, { maxEvents: eventLogLimit }),

        listRecords(entity) {
            return backendFor(entity).list();
        },

        /**
         * Records whose top-level `field` equals `value` (a string), oldest
         * first. Example: findRecords('Player', 'room_id', roomId).
         */
        findRecords(entity, field, value) {
            return backendFor(entity).find(field, value);
        },

        /**
         * Records whose `email` matches `email` ignoring case and surrounding
         * spaces, oldest first. `email` must already be trimmed and lowercase.
         */
        findRecordsByEmail(entity, email) {
            return backendFor(entity).findByEmail(email);
        },

        getRecord(entity, id) {
            return backendFor(entity).get(id);
        },

        createRecords(entity, items, createdBy) {
            return translateConstraintErrors(() => insertMany(entity, items, createdBy));
        },

        updateRecord(entity, id, changes) {
            return translateConstraintErrors(() => updateOne(entity, id, changes));
        },

        /** Deletes and returns the record as it was, or null if it didn't exist. */
        deleteRecord(entity, id) {
            return backendFor(entity).remove(id);
        },

        /**
         * Runs `fn` inside one SQLite transaction and returns its result. A
         * throw rolls everything back. better-sqlite3 transactions are
         * synchronous, so `fn` must not await. Store calls inside it (even
         * createRecords, which nests a savepoint) join the same transaction.
         */
        transaction(fn) {
            return db.transaction(fn)();
        },

        // The user functions take an email in any spelling; users.email only holds the canonical one.

        findUserByEmail(email) {
            return users.findUser.get(canonicalEmail(email)) || null;
        },

        /**
         * Inserts the user on first sight. An existing user keeps their stored
         * name unless a non-empty `fullName` is given (e.g. from the dev login form).
         */
        upsertUser(email, fullName) {
            const storedEmail = canonicalEmail(email);
            const existing = users.findUser.get(storedEmail);
            if (!existing) {
                const timestamp = now();
                users.insertUser.run(generateId(), storedEmail, fullName || null, timestamp, timestamp);
            } else if (fullName && fullName !== existing.full_name) {
                users.updateUserName.run(fullName, now(), storedEmail);
            }
            return users.findUser.get(storedEmail);
        },

        setUserName(email, fullName) {
            const storedEmail = canonicalEmail(email);
            users.updateUserName.run(fullName, now(), storedEmail);
            return users.findUser.get(storedEmail);
        },

        close() {
            db.close();
        },
    };
}
