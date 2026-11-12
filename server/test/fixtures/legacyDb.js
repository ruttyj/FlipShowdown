import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// A database as servers before the migration runner left it: the schema db.js used to exec on
// every start, and no schema_migrations table. Frozen here so later migrations can't change it.
const LEGACY_SCHEMA = `
    CREATE TABLE IF NOT EXISTS records (
        seq          INTEGER PRIMARY KEY AUTOINCREMENT,
        entity       TEXT NOT NULL,
        id           TEXT NOT NULL,
        data         TEXT NOT NULL,
        created_date TEXT NOT NULL,
        updated_date TEXT NOT NULL,
        created_by   TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS records_entity_id ON records (entity, id);
    CREATE INDEX IF NOT EXISTS records_room_id ON records (entity, json_extract(data, '$.room_id'));
    CREATE INDEX IF NOT EXISTS records_email ON records (entity, lower(trim(json_extract(data, '$.email'))));
    CREATE INDEX IF NOT EXISTS records_code ON records (entity, json_extract(data, '$.code'));

    CREATE TABLE IF NOT EXISTS users (
        id           TEXT PRIMARY KEY,
        email        TEXT NOT NULL UNIQUE,
        full_name    TEXT,
        created_date TEXT NOT NULL,
        updated_date TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
        seq     INTEGER PRIMARY KEY,
        room_id TEXT,
        entity  TEXT NOT NULL,
        text    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
`;

const DEFAULT_DATE = '2025-06-01T12:00:00.000Z';

function randomId() {
    return crypto.randomBytes(12).toString('hex');
}

/**
 * Writes DATA_DIR/flip7.db with the legacy schema and returns helpers that fill it with raw rows:
 * - insertRecord(entity, data, { id, created_date, updated_date, created_by }) -> the row's id
 * - insertUser(email, fullName, { id, created_date, updated_date }) -> the user's id
 * - db: the open connection, for anything else
 * - close(): call it before opening the store on the same directory
 */
export function createLegacyDb(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    const db = new Database(path.join(dataDir, 'flip7.db'));
    db.pragma('journal_mode = WAL');
    db.exec(LEGACY_SCHEMA);

    const insertRecordStatement = db.prepare(
        'INSERT INTO records (entity, id, data, created_date, updated_date, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insertUserStatement = db.prepare(
        'INSERT INTO users (id, email, full_name, created_date, updated_date) VALUES (?, ?, ?, ?, ?)',
    );

    return {
        db,

        insertRecord(entity, data, extras = {}) {
            const id = extras.id ?? randomId();
            const createdDate = extras.created_date ?? DEFAULT_DATE;
            const updatedDate = extras.updated_date ?? createdDate;
            const createdBy = extras.created_by ?? null;
            insertRecordStatement.run(entity, id, JSON.stringify(data), createdDate, updatedDate, createdBy);
            return id;
        },

        insertUser(email, fullName = null, extras = {}) {
            const id = extras.id ?? randomId();
            const createdDate = extras.created_date ?? DEFAULT_DATE;
            const updatedDate = extras.updated_date ?? createdDate;
            insertUserStatement.run(id, email, fullName, createdDate, updatedDate);
            return id;
        },

        /** Every records row as the legacy store returned it: `[{ seq, entity, record }]` in seq order. */
        readRecords() {
            const rows = db.prepare('SELECT * FROM records ORDER BY seq').all();
            return rows.map((row) => ({
                seq: row.seq,
                entity: row.entity,
                record: {
                    ...JSON.parse(row.data),
                    id: row.id,
                    created_date: row.created_date,
                    updated_date: row.updated_date,
                    created_by: row.created_by,
                },
            }));
        },

        close() {
            db.close();
        },
    };
}
