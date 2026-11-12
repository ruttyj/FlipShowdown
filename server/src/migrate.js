import path from 'node:path';
import { fileTimestamp, snapshotDatabase } from './backup.js';

// Brings a database's schema up to date. Migrations are the numbered files in migrations/ (listed
// in migrations/index.js), each `{ version, name, up(db) }`. Each pending one runs once, in version
// order, in its own transaction, and is recorded in schema_migrations by the same transaction, so
// a failure leaves neither a half-applied change nor a record of it.

// Tables whose rows mean the database holds someone's data, so it's worth a copy before migrating.
const DATA_TABLES = ['users', 'records'];

// --- Bookkeeping -------------------------------------------------------------

function ensureMigrationsTable(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version    INTEGER PRIMARY KEY,
            name       TEXT NOT NULL,
            applied_at TEXT NOT NULL
        )
    `);
}

function readAppliedVersions(db) {
    const rows = db.prepare('SELECT version FROM schema_migrations').all();
    return new Set(rows.map((row) => row.version));
}

function isApplied(db, version) {
    return db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version) !== undefined;
}

function highestVersion(versions) {
    let highest = 0;
    for (const version of versions) {
        highest = Math.max(highest, version);
    }
    return highest;
}

/** An older server must not run on a schema it doesn't know: it would misread or damage the data. */
function assertNotNewer(appliedVersion, knownVersion) {
    if (appliedVersion > knownVersion) {
        throw new Error(
            `The database is at schema version ${appliedVersion}, which was written by a newer version of ` +
                `Flip Showdown (this one knows up to ${knownVersion}). Update the server or restore a backup.`,
        );
    }
}

// --- Pre-migration snapshot --------------------------------------------------

function tableHasRows(db, table) {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!exists) {
        return false;
    }
    // `table` comes from DATA_TABLES, never from input.
    return db.prepare(`SELECT 1 FROM "${table}" LIMIT 1`).get() !== undefined;
}

function hasUserData(db) {
    return DATA_TABLES.some((table) => tableHasRows(db, table));
}

/**
 * Copies the database to `<snapshotDir>/pre-migration-<from>-to-<to>-<timestamp>.db`. Migrations
 * can rewrite every row, and a desktop user never takes a backup by hand, so this copy is the way
 * back if one goes wrong. It's synchronous because opening the store is.
 */
function snapshotBeforeMigrating(db, { snapshotDir, fromVersion, toVersion, now }) {
    const fileName = `pre-migration-${fromVersion}-to-${toVersion}-${fileTimestamp(now())}.db`;
    snapshotDatabase(db, path.join(snapshotDir, fileName));
}

// --- Applying ----------------------------------------------------------------

function assertForeignKeysIntact(db, migration) {
    const violations = db.pragma('foreign_key_check');
    if (violations.length === 0) {
        return;
    }

    const first = violations[0];
    throw new Error(
        `Migration ${migration.version} (${migration.name}) left ${violations.length} broken foreign key ` +
            `reference(s), the first in ${first.table} row ${first.rowid} pointing at ${first.parent}`,
    );
}

/**
 * Applies one migration in a write transaction. Returns false when it turns out to be recorded
 * already: another server process on the same DATA_DIR got there first. BEGIN IMMEDIATE takes the
 * write lock up front, so that check and the migration can't interleave with the other process.
 */
function applyMigration(db, migration, now) {
    const apply = db.transaction(() => {
        if (isApplied(db, migration.version)) {
            return false;
        }

        migration.up(db);
        assertForeignKeysIntact(db, migration);
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
            migration.version,
            migration.name,
            now().toISOString(),
        );
        return true;
    });
    return apply.immediate();
}

/**
 * Runs the pending `migrations` (sorted by version) on `db` and returns the versions it applied.
 * Throws if the database is newer than the list or a migration fails; the failed migration is
 * rolled back and the ones after it don't run.
 *
 * Options: `now` returns the current Date (tests); `snapshotDir`, when set, is where a copy of a
 * database holding data goes before any pending migration runs.
 */
export function runMigrations(db, migrations, { now = () => new Date(), snapshotDir = null } = {}) {
    ensureMigrationsTable(db);

    const appliedVersions = readAppliedVersions(db);
    const fromVersion = highestVersion(appliedVersions);
    const toVersion = highestVersion(migrations.map((migration) => migration.version));
    assertNotNewer(fromVersion, toVersion);

    const pending = migrations.filter((migration) => !appliedVersions.has(migration.version));
    if (pending.length === 0) {
        return [];
    }

    if (snapshotDir && hasUserData(db)) {
        snapshotBeforeMigrating(db, { snapshotDir, fromVersion, toVersion, now });
    }

    // Table rebuilds (create, copy, drop, rename) would trip foreign keys midway, so they're off
    // while migrating, and foreign_key_check verifies each migration's end state instead. The
    // pragma is a no-op inside a transaction, which is why it's set out here.
    const foreignKeysWereOn = db.pragma('foreign_keys', { simple: true }) === 1;
    db.pragma('foreign_keys = OFF');
    try {
        const applied = [];
        for (const migration of pending) {
            if (applyMigration(db, migration, now)) {
                applied.push(migration.version);
            }
        }
        return applied;
    } finally {
        if (foreignKeysWereOn) {
            db.pragma('foreign_keys = ON');
        }
    }
}
