import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { openDatabase, openStore } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { MIGRATIONS } from '../src/migrations/index.js';
import { createLegacyDb } from './fixtures/legacyDb.js';

// The migration runner: numbered migrations, each applied once, in order, in its own transaction,
// with a snapshot of an existing database taken before any of them run.

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'migrations');
const FIXED_NOW = () => new Date('2026-01-02T03:04:05.678Z');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-migrate-'));
}

function appliedVersions(db) {
    return db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version);
}

function tableExists(db, name) {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/** A migration that creates table `t<version>` and records that it ran in `calls`. */
function createTableMigration(version, calls) {
    return {
        version,
        name: `create_t${version}`,
        up(db) {
            calls.push(version);
            db.exec(`CREATE TABLE t${version} (id INTEGER PRIMARY KEY)`);
        },
    };
}

// --- Runner on a bare database ----------------------------------------------

describe('runMigrations', () => {
    let db;

    beforeEach(() => {
        db = new Database(':memory:');
    });

    afterEach(() => {
        db.close();
    });

    test('applies every migration in order and records each version', () => {
        const calls = [];
        const migrations = [createTableMigration(1, calls), createTableMigration(2, calls)];

        const applied = runMigrations(db, migrations, { now: FIXED_NOW });

        assert.deepEqual(applied, [1, 2]);
        assert.deepEqual(calls, [1, 2]);
        const rows = db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all();
        assert.deepEqual(rows, [
            { version: 1, name: 'create_t1', applied_at: '2026-01-02T03:04:05.678Z' },
            { version: 2, name: 'create_t2', applied_at: '2026-01-02T03:04:05.678Z' },
        ]);
    });

    test('applies nothing when every migration is already recorded', () => {
        const calls = [];
        const migrations = [createTableMigration(1, calls)];
        runMigrations(db, migrations);

        const applied = runMigrations(db, migrations);

        assert.deepEqual(applied, []);
        assert.deepEqual(calls, [1]);
    });

    test('runs only the pending migrations, in order', () => {
        const calls = [];
        runMigrations(db, [createTableMigration(1, calls)]);

        const applied = runMigrations(db, [
            createTableMigration(1, calls),
            createTableMigration(2, calls),
            createTableMigration(3, calls),
        ]);

        assert.deepEqual(applied, [2, 3]);
        assert.deepEqual(calls, [1, 2, 3]);
        assert.deepEqual(appliedVersions(db), [1, 2, 3]);
    });

    test('a throwing migration leaves no partial change, no record and stops the later ones', () => {
        const calls = [];
        const failing = {
            version: 2,
            name: 'half_done',
            up(database) {
                database.exec('CREATE TABLE half (id INTEGER PRIMARY KEY)');
                throw new Error('boom');
            },
        };

        assert.throws(
            () => runMigrations(db, [createTableMigration(1, calls), failing, createTableMigration(3, calls)]),
            /boom/,
        );

        assert.deepEqual(appliedVersions(db), [1]);
        assert.equal(tableExists(db, 'half'), false);
        assert.deepEqual(calls, [1]);
    });

    test('a migration that leaves a broken foreign key is rolled back', () => {
        const dangling = {
            version: 1,
            name: 'dangling_child',
            up(database) {
                database.exec(`
                    CREATE TABLE parent (id TEXT PRIMARY KEY);
                    CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id));
                    INSERT INTO child (id, parent_id) VALUES ('c1', 'missing');
                `);
            },
        };

        assert.throws(() => runMigrations(db, [dangling]), /foreign key.*child/i);

        assert.deepEqual(appliedVersions(db), []);
        assert.equal(tableExists(db, 'child'), false);
    });

    test('runs migrations with foreign keys off and restores the previous setting afterwards', () => {
        db.pragma('foreign_keys = ON');
        let seenDuringMigration;
        const probe = {
            version: 1,
            name: 'probe',
            up(database) {
                seenDuringMigration = database.pragma('foreign_keys', { simple: true });
            },
        };

        runMigrations(db, [probe]);

        assert.equal(seenDuringMigration, 0);
        assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    });

    test('skips a migration another process recorded after the pending list was read', () => {
        const calls = [];
        // Stands in for a second server on the same DATA_DIR that applied version 2 while this one
        // was busy with version 1.
        const recordsVersionTwo = {
            version: 1,
            name: 'first',
            up(database) {
                database
                    .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (2, ?, ?)')
                    .run('second', 'elsewhere');
            },
        };

        const applied = runMigrations(db, [recordsVersionTwo, createTableMigration(2, calls)]);

        assert.deepEqual(applied, [1]);
        assert.deepEqual(calls, []);
    });

    test('refuses a database written by a newer version', () => {
        runMigrations(db, [createTableMigration(1, []), createTableMigration(2, [])]);

        assert.throws(() => runMigrations(db, [createTableMigration(1, [])]), /written by a newer version/);
    });
});

// --- Pre-migration snapshot --------------------------------------------------

describe('pre-migration snapshot', () => {
    let dir;

    beforeEach(() => {
        dir = makeTempDir();
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function listBackups() {
        const backupsDir = path.join(dir, 'backups');
        if (!fs.existsSync(backupsDir)) {
            return [];
        }
        return fs.readdirSync(backupsDir);
    }

    test('a fresh database gets no snapshot', () => {
        const store = openStore(dir);
        store.close();

        assert.deepEqual(listBackups(), []);
    });

    test('an existing database with data is copied before its pending migrations run', () => {
        const legacy = createLegacyDb(dir);
        legacy.insertUser('Ann@X.com', 'Ann');
        legacy.close();

        const db = new Database(path.join(dir, 'flip7.db'));
        runMigrations(db, MIGRATIONS, { now: FIXED_NOW, snapshotDir: path.join(dir, 'backups') });
        db.close();

        const latest = MIGRATIONS.at(-1).version;
        const expectedName = `pre-migration-0-to-${latest}-2026-01-02T03-04-05-678Z.db`;
        assert.deepEqual(listBackups(), [expectedName]);

        // The snapshot is the database as it was: no migrations recorded, the email as typed.
        const snapshot = new Database(path.join(dir, 'backups', expectedName), { readonly: true });
        try {
            assert.deepEqual(appliedVersions(snapshot), []);
            assert.equal(snapshot.prepare('SELECT email FROM users').get().email, 'Ann@X.com');
        } finally {
            snapshot.close();
        }
    });

    test('an existing database with only empty tables gets no snapshot', () => {
        createLegacyDb(dir).close();

        const store = openStore(dir);
        store.close();

        assert.deepEqual(listBackups(), []);
    });

    test('reopening an up-to-date database takes no snapshot', () => {
        const store = openStore(dir);
        store.upsertUser('bob@x.com', 'Bob');
        store.close();

        const reopened = openStore(dir);
        reopened.close();

        assert.deepEqual(listBackups(), []);
    });
});

// --- Registry and store wiring -----------------------------------------------

describe('migration registry', () => {
    test('lists every NNNN_name.js file in the migrations folder, in order', () => {
        const files = fs
            .readdirSync(MIGRATIONS_DIR)
            .filter((file) => /^\d{4}_\w+\.js$/.test(file))
            .sort();

        const registered = MIGRATIONS.map((migration) => {
            const paddedVersion = String(migration.version).padStart(4, '0');
            return `${paddedVersion}_${migration.name}.js`;
        });

        assert.deepEqual(registered, files);
        for (const migration of MIGRATIONS) {
            assert.equal(typeof migration.up, 'function', migration.name);
        }
    });
});

describe('openDatabase and openStore', () => {
    let dir;

    beforeEach(() => {
        dir = makeTempDir();
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('records every migration on a fresh database', () => {
        const store = openStore(dir);
        store.close();

        const db = new Database(path.join(dir, 'flip7.db'), { readonly: true });
        try {
            assert.deepEqual(
                appliedVersions(db),
                MIGRATIONS.map((migration) => migration.version),
            );
        } finally {
            db.close();
        }
    });

    test('refuses a database from a newer version and releases the file', () => {
        const future = new Database(path.join(dir, 'flip7.db'));
        runMigrations(future, [...MIGRATIONS, { version: 999, name: 'from_the_future', up() {} }]);
        future.close();

        assert.throws(() => openStore(dir), /written by a newer version/);

        // Windows can't rename a file that is still open, so this fails if the connection leaked.
        fs.renameSync(path.join(dir, 'flip7.db'), path.join(dir, 'moved.db'));
    });

    test('hands out a connection with foreign keys enforced, also when nothing was pending', () => {
        openStore(dir).close();

        const db = openDatabase(dir);
        try {
            assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
        } finally {
            db.close();
        }
    });
});
