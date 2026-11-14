import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import SqliteConnection from 'better-sqlite3';
import { Database } from '../src/database/Database.js';
import { runMigrations } from '../src/database/migrate.js';
import { MIGRATIONS } from '../src/database/migrations/index.js';
import { createLegacyDb } from './fixtures/legacyDb.js';

// Database: the one SQLite connection, opened with its settings and an up-to-date schema, plus
// the transactions the repositories run in.

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-database-'));
}

function appliedVersions(database) {
    const rows = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
    return rows.map((row) => row.version);
}

function listBackups(dir) {
    const backupsDir = path.join(dir, 'backups');
    if (!fs.existsSync(backupsDir)) {
        return [];
    }
    return fs.readdirSync(backupsDir);
}

// --- Opening -----------------------------------------------------------------

describe('Database.open', () => {
    let dir;

    beforeEach(() => {
        dir = makeTempDir();
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('creates the data folder and the file, with every migration applied', () => {
        const dataDir = path.join(dir, 'nested', 'data');

        const database = Database.open(dataDir);
        try {
            assert.ok(fs.existsSync(path.join(dataDir, 'flip7.db')));
            assert.deepEqual(appliedVersions(database), MIGRATIONS.map((migration) => migration.version));
        } finally {
            database.close();
        }
    });

    test('uses WAL with synchronous NORMAL and enforces foreign keys', () => {
        const database = Database.open(dir);
        try {
            assert.equal(database.connection.pragma('journal_mode', { simple: true }), 'wal');
            // NORMAL is 1.
            assert.equal(database.connection.pragma('synchronous', { simple: true }), 1);
            assert.equal(database.connection.pragma('foreign_keys', { simple: true }), 1);
        } finally {
            database.close();
        }
    });

    test('a fresh database gets no pre-migration copy', () => {
        Database.open(dir).close();

        assert.deepEqual(listBackups(dir), []);
    });

    test('copies a database that holds data before migrating it', () => {
        const legacy = createLegacyDb(dir);
        legacy.insertUser('ann@x.com', 'Ann');
        legacy.close();

        Database.open(dir).close();

        const backups = listBackups(dir);
        assert.equal(backups.length, 1);
        assert.match(backups[0], /^pre-migration-0-to-\d+-.*\.db$/);
    });

    test('refuses a database from a newer version and releases the file', () => {
        const future = new SqliteConnection(path.join(dir, 'flip7.db'));
        runMigrations(future, [...MIGRATIONS, { version: 999, name: 'from_the_future', up() {} }]);
        future.close();

        assert.throws(() => Database.open(dir), /written by a newer version/);

        // Windows can't rename a file that is still open, so this fails if the connection leaked.
        fs.renameSync(path.join(dir, 'flip7.db'), path.join(dir, 'moved.db'));
    });
});

// --- Queries and transactions ------------------------------------------------

describe('Database queries and transactions', () => {
    let database;

    beforeEach(() => {
        // An in-memory connection is enough here: these tests need a table, not the schema.
        database = new Database(new SqliteConnection(':memory:'));
        database.connection.exec('CREATE TABLE notes (text TEXT NOT NULL)');
    });

    afterEach(() => {
        if (database.connection.open) {
            database.close();
        }
    });

    function insertNote(text) {
        database.prepare('INSERT INTO notes (text) VALUES (?)').run(text);
    }

    function readNotes() {
        const rows = database.prepare('SELECT text FROM notes ORDER BY rowid').all();
        return rows.map((row) => row.text);
    }

    test('prepare returns a statement that runs on the connection', () => {
        insertNote('first');

        assert.deepEqual(readNotes(), ['first']);
    });

    test('transaction returns what fn returns and keeps its writes', () => {
        const result = database.transaction(() => {
            insertNote('kept');
            return 'done';
        });

        assert.equal(result, 'done');
        assert.deepEqual(readNotes(), ['kept']);
    });

    test('a throw inside a transaction rolls it back and reaches the caller', () => {
        const failure = new Error('stop');

        assert.throws(
            () => database.transaction(() => {
                insertNote('lost');
                throw failure;
            }),
            (error) => error === failure,
        );
        assert.deepEqual(readNotes(), []);
    });

    test('a nested transaction that throws rolls back only its own writes', () => {
        database.transaction(() => {
            insertNote('outer');
            assert.throws(() => database.transaction(() => {
                insertNote('inner');
                throw new Error('inner failed');
            }));
        });

        assert.deepEqual(readNotes(), ['outer']);
    });

    test('a throw in the outer transaction also undoes a nested one that finished', () => {
        assert.throws(() => database.transaction(() => {
            database.transaction(() => insertNote('inner'));
            throw new Error('outer failed');
        }));

        assert.deepEqual(readNotes(), []);
    });

    test('close closes the connection', () => {
        database.close();

        assert.equal(database.connection.open, false);
    });
});
