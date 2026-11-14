import { canonicalEmail } from '../lib/email.js';
import { TableRepository } from '../repositories/TableRepository.js';
import { currentTimestamp, generateId, stripServerFields } from '../repositories/recordFields.js';
import { Database } from './Database.js';
import { ENTITY_TABLES, translateConstraintErrors } from './entityTables.js';
import { createEventLog } from './eventLog.js';

// The store: the record-shaped API the routes and tests use, over Database and one
// TableRepository per game table. Users, the generic `records` table and the event log are still
// handled here.

// --- Users ---------------------------------------------------------------

function prepareUserStatements(database) {
    return {
        findUser: database.prepare('SELECT * FROM users WHERE email = ?'),
        insertUser: database.prepare(
            'INSERT INTO users (id, email, full_name, created_date, updated_date) VALUES (?, ?, ?, ?, ?)',
        ),
        updateUserName: database.prepare('UPDATE users SET full_name = ?, updated_date = ? WHERE email = ?'),
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
    const timestamp = currentTimestamp();
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

function prepareRecordStatements(database) {
    return {
        listRecords: database.prepare('SELECT * FROM records WHERE entity = ? ORDER BY seq'),
        getRecord: database.prepare('SELECT * FROM records WHERE entity = ? AND id = ?'),
        // room_id is the one field with an expression index (records_room_id, migration 0001).
        findByRoomId: database.prepare(
            "SELECT * FROM records WHERE entity = ? AND json_extract(data, '$.room_id') = ? ORDER BY seq",
        ),
        // Unindexed fallback: the path is a parameter, so no index can match it.
        findRecords: database.prepare('SELECT * FROM records WHERE entity = ? AND json_extract(data, ?) = ? ORDER BY seq'),
        insertRecord: database.prepare(
            'INSERT INTO records (entity, id, data, created_date, updated_date, created_by) VALUES (?, ?, ?, ?, ?, ?)',
        ),
        updateRecord: database.prepare('UPDATE records SET data = ?, updated_date = ? WHERE entity = ? AND id = ?'),
        deleteRecord: database.prepare('DELETE FROM records WHERE entity = ? AND id = ?'),
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
    const timestamp = currentTimestamp();
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
    statements.updateRecord.run(JSON.stringify(merged), currentTimestamp(), entity, id);
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

/** The store operations for one entity with its own table. */
function tableBackend(repository) {
    return {
        list: () => repository.list(),
        find: (field, value) => repository.find(field, value),
        findByEmail: (email) => repository.find('email', email),
        get: (id) => repository.get(id),
        insert: (item, createdBy) => repository.insert(item, createdBy),
        update: (id, changes) => repository.update(id, changes),
        remove: (id) => repository.delete(id),
    };
}

/** Entity name -> backend for the four entities that have their own table. */
function createTableBackends(database, users) {
    const resolveUser = (email) => resolveUserId(users, email);
    const backends = new Map();
    for (const [entity, spec] of ENTITY_TABLES) {
        const repository = new TableRepository(database, spec, { resolveUserId: resolveUser });
        backends.set(entity, tableBackend(repository));
    }
    return backends;
}

// --- Store ---------------------------------------------------------------

/**
 * Opens the database (see Database.open) and returns its raw better-sqlite3 connection, with
 * foreign keys enforced. Kept for tests that read the migrated file directly; the server itself
 * goes through openStore.
 */
export function openDatabase(dataDir) {
    return Database.open(dataDir).connection;
}

/**
 * Opens the database (see Database.open) and returns a small store API.
 * All methods are synchronous, so each request's write is atomic.
 * GameRoom, Player, RoundScore and ChatMessage live in their own tables (see entityTables.js);
 * any other entity is a JSON row in `records`. Both give the same record shape.
 * Writes the database refuses throw a StoreError (400 or 409).
 * `eventLogLimit` overrides how many realtime events are kept (tests).
 */
export function openStore(dataDir, { eventLogLimit } = {}) {
    const database = Database.open(dataDir);

    const users = prepareUserStatements(database);
    const recordStatements = prepareRecordStatements(database);
    const tableBackends = createTableBackends(database, users);

    function backendFor(entity) {
        return tableBackends.get(entity) ?? genericBackend(recordStatements, entity);
    }

    // TableRepository already turns constraint errors into StoreErrors, so only writes to the
    // generic `records` backend need converting here.
    function translateGenericErrors(entity, write) {
        if (tableBackends.has(entity)) {
            return write();
        }
        return translateConstraintErrors(write);
    }

    // The whole batch is all-or-nothing, users created for its players included.
    function insertMany(entity, items, createdBy) {
        return database.transaction(() => {
            const backend = backendFor(entity);
            const records = [];
            for (const item of items) {
                records.push(backend.insert(item, createdBy));
            }
            return records;
        });
    }

    // A transaction too, so a user created for the update goes away if the update fails.
    function updateOne(entity, id, changes) {
        return database.transaction(() => backendFor(entity).update(id, changes));
    }

    return {
        // The event log still takes the raw connection; it moves onto Database in a later step.
        eventLog: createEventLog(database.connection, { maxEvents: eventLogLimit }),

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
            return translateGenericErrors(entity, () => insertMany(entity, items, createdBy));
        },

        updateRecord(entity, id, changes) {
            return translateGenericErrors(entity, () => updateOne(entity, id, changes));
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
            return database.transaction(fn);
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
                const timestamp = currentTimestamp();
                users.insertUser.run(generateId(), storedEmail, fullName || null, timestamp, timestamp);
            } else if (fullName && fullName !== existing.full_name) {
                users.updateUserName.run(fullName, currentTimestamp(), storedEmail);
            }
            return users.findUser.get(storedEmail);
        },

        setUserName(email, fullName) {
            const storedEmail = canonicalEmail(email);
            users.updateUserName.run(fullName, currentTimestamp(), storedEmail);
            return users.findUser.get(storedEmail);
        },

        close() {
            database.close();
        },
    };
}
