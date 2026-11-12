// The schema as it was before migrations existed, when db.js ran it on every start. IF NOT EXISTS
// makes it a no-op on those databases and the starting point for new ones. Frozen: never edit a
// migration that has shipped; add a new one instead. Migrations never import from src/ either, so
// later code changes can't change what they do.

const SCHEMA = `
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
    -- Expression indexes for findRecords. SQLite only uses them when a query
    -- spells the expression the same way, path literal included.
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

    -- Realtime event log (see eventLog.js). text is the event message as sent.
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

export function up(db) {
    db.exec(SCHEMA);
}
