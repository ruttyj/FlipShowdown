import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { backupDatabase } from '../src/backup.js';
import { openStore } from '../src/db.js';

// `npm run backup`: a copy of DATA_DIR/flip7.db in DATA_DIR/backups, safe to take while the server runs.

const SERVER_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const runFile = promisify(execFile);

function readUserEmails(databasePath) {
    const db = new Database(databasePath, { readonly: true });
    try {
        return db
            .prepare('SELECT email FROM users ORDER BY email')
            .all()
            .map((row) => row.email);
    } finally {
        db.close();
    }
}

/** Runs `node src/backup.js` with DATA_DIR set, resolving to { code, stdout, stderr }. */
async function runBackupScript(dataDir) {
    const options = { cwd: SERVER_ROOT, env: { ...process.env, DATA_DIR: dataDir } };
    try {
        const { stdout, stderr } = await runFile(process.execPath, ['src/backup.js'], options);
        return { code: 0, stdout, stderr };
    } catch (error) {
        return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
}

describe('backupDatabase', () => {
    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-backup-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('writes a timestamped copy to DATA_DIR/backups that holds the data', async () => {
        const store = openStore(dir);
        store.upsertUser('ann@x.com', 'Ann');
        store.close();

        const destination = await backupDatabase(dir, { now: () => new Date('2026-01-02T03:04:05.678Z') });

        assert.equal(destination, path.join(dir, 'backups', 'flip7-2026-01-02T03-04-05-678Z.db'));
        assert.deepEqual(readUserEmails(destination), ['ann@x.com']);
    });

    test('includes a write still in the WAL file of a connection that is open', async () => {
        const store = openStore(dir);
        try {
            store.upsertUser('ann@x.com', 'Ann');
            store.upsertUser('bob@x.com', 'Bob');

            const destination = await backupDatabase(dir);

            assert.deepEqual(readUserEmails(destination), ['ann@x.com', 'bob@x.com']);
        } finally {
            store.close();
        }
    });

    test('fails without creating a database when there is none', async () => {
        await assert.rejects(backupDatabase(dir), /No database at/);

        assert.equal(fs.existsSync(path.join(dir, 'flip7.db')), false);
    });
});

describe('backup script', () => {
    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-backup-cli-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('backs up the DATA_DIR database and prints where the copy went', async () => {
        const store = openStore(dir);
        store.upsertUser('ann@x.com', 'Ann');
        store.close();

        const result = await runBackupScript(dir);

        assert.equal(result.code, 0, result.stderr);
        const backups = fs.readdirSync(path.join(dir, 'backups'));
        assert.equal(backups.length, 1);
        assert.match(result.stdout, new RegExp(`Backup written to .*${backups[0].replace(/\./g, '\\.')}`));
    });

    test('exits 1 with a message when DATA_DIR has no database', async () => {
        const result = await runBackupScript(dir);

        assert.equal(result.code, 1);
        assert.match(result.stderr, /Backup failed: No database at/);
    });
});
