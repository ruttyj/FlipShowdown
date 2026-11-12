import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { DATABASE_FILE, resolveDataDir } from './config.js';

// Copies of the database. `npm run backup` (this file run directly) takes one by hand, and the
// migration runner takes one before it changes the schema of a database holding data.

/** Where both kinds of copy go: DATA_DIR/backups. */
export function backupsDir(dataDir) {
    return path.join(dataDir, 'backups');
}

/** A Date as text safe in a file name on every OS: "2026-01-02T03:04:05.678Z" -> "2026-01-02T03-04-05-678Z". */
export function fileTimestamp(date) {
    return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * Writes a copy of the open database `db` to `destination` in one synchronous statement, for
 * callers that can't await (the migration runner). The file must not exist yet.
 */
export function snapshotDatabase(db, destination) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    db.prepare('VACUUM INTO ?').run(destination);
}

/**
 * Copies DATA_DIR/flip7.db to DATA_DIR/backups/flip7-<timestamp>.db with SQLite's online backup,
 * which is safe while the server is running and includes writes still in the WAL file. Returns the
 * copy's path. `now` returns the current Date (tests).
 */
export async function backupDatabase(dataDir, { now = () => new Date() } = {}) {
    const source = path.join(dataDir, DATABASE_FILE);
    if (!fs.existsSync(source)) {
        throw new Error(`No database at ${source}`);
    }

    const destination = path.join(backupsDir(dataDir), `flip7-${fileTimestamp(now())}.db`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });

    // fileMustExist: if the file vanished since the check above, fail rather than back up a new empty one.
    const db = new Database(source, { fileMustExist: true });
    try {
        await db.backup(destination);
    } finally {
        db.close();
    }
    return destination;
}

// --- Command line ------------------------------------------------------------

async function main() {
    try {
        const destination = await backupDatabase(resolveDataDir(process.env));
        console.log(`Backup written to ${destination}`);
    } catch (error) {
        console.error(`Backup failed: ${error.message}`);
        process.exitCode = 1;
    }
}

const isRunDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isRunDirectly) {
    await main();
}
