import fs from 'node:fs';
import path from 'node:path';
import SqliteConnection from 'better-sqlite3';
import { DATABASE_FILE } from '../config/config.js';
import { backupsDir } from './backup.js';
import { runMigrations } from './migrate.js';
import { MIGRATIONS } from './migrations/index.js';

// The server's one SQLite connection. Opening brings the schema up to date (see migrate.js), and
// every query and transaction the repositories run goes through here.

/** Applies the connection settings and migrations to a freshly opened connection. */
function prepareConnection(connection, dataDir) {
    connection.pragma('journal_mode = WAL');
    connection.pragma('synchronous = NORMAL');
    // A database that holds data is copied to DATA_DIR/backups before any pending migration runs.
    runMigrations(connection, MIGRATIONS, { snapshotDir: backupsDir(dataDir) });
    // Enforced from here on; a new connection starts with foreign keys off.
    connection.pragma('foreign_keys = ON');
}

export class Database {
    /**
     * Opens (creating if needed) DATA_DIR/flip7.db and brings its schema up to date. Before
     * migrating a database that holds data, it saves a copy in DATA_DIR/backups. Foreign keys are
     * enforced on the returned database. Throws, with the file released, if migrating fails.
     */
    static open(dataDir) {
        fs.mkdirSync(dataDir, { recursive: true });

        const connection = new SqliteConnection(path.join(dataDir, DATABASE_FILE));
        try {
            prepareConnection(connection, dataDir);
        } catch (error) {
            // Release the file, so the caller (or a test's cleanup) can move or delete it.
            connection.close();
            throw error;
        }
        return new Database(connection);
    }

    /** `connection` is an open better-sqlite3 connection; Database.open builds the real one. */
    constructor(connection) {
        this.connection = connection;
    }

    /** A prepared statement for `sql`. Prepare once and reuse it: preparing parses the SQL. */
    prepare(sql) {
        return this.connection.prepare(sql);
    }

    /**
     * Runs `fn` (with no arguments) inside one SQLite transaction and returns its result. A throw
     * rolls everything back and is rethrown. better-sqlite3 transactions are synchronous, so `fn`
     * must not await. A transaction started inside `fn` becomes a savepoint of this one: its throw
     * rolls back only its own writes, and nothing commits until the outermost one returns.
     */
    transaction(fn) {
        return this.connection.transaction(fn)();
    }

    /**
     * Builds the transaction once and returns a function that runs `fn` in it with the arguments
     * it is given, for a hot path where `transaction` would build a new wrapper on every call.
     * Same rollback and savepoint behaviour as `transaction`.
     */
    prepareTransaction(fn) {
        return this.connection.transaction(fn);
    }

    close() {
        this.connection.close();
    }
}
