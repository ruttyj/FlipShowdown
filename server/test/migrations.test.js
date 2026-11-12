import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { openStore } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { MIGRATIONS } from '../src/migrations/index.js';
import { createLegacyDb } from './fixtures/legacyDb.js';

// Upgrading a database written before migrations existed, through 0001 and 0002. These stop at
// 0002 and read the result with raw SQL, because 0004 moves the game records out of `records`
// (legacyUpgrade.test.js covers that move).

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-migrations-'));
}

/** Runs migrations 0001 and 0002 on DATA_DIR/flip7.db and returns the open connection. */
function upgrade(dir) {
    const db = new Database(path.join(dir, 'flip7.db'));
    const throughEmails = MIGRATIONS.filter((migration) => migration.version <= 2);
    runMigrations(db, throughEmails);
    return db;
}

function readRecord(db, id) {
    const row = db.prepare('SELECT * FROM records WHERE id = ?').get(id);
    return { ...row, data: JSON.parse(row.data) };
}

// --- 0001 baseline -----------------------------------------------------------

describe('upgrading a legacy database', () => {
    let dir;
    let db;

    beforeEach(() => {
        dir = makeTempDir();
    });

    afterEach(() => {
        db?.close();
        db = undefined;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('keeps every record', () => {
        const legacy = createLegacyDb(dir);
        const roomId = legacy.insertRecord('GameRoom', { code: 'ABCD', status: 'waiting' });
        legacy.insertRecord('Player', { room_id: roomId, email: 'ann@x.com', name: 'Ann' });
        legacy.insertRecord('Note', { text: 'kept as is' });
        const before = legacy.db.prepare('SELECT seq, entity, id, data FROM records ORDER BY seq').all();
        legacy.close();

        db = upgrade(dir);

        const after = db.prepare('SELECT seq, entity, id, data FROM records ORDER BY seq').all();
        assert.deepEqual(after, before);
    });

    // --- 0002 email normalisation ---------------------------------------------

    test('merges users that differ only by case or spaces into the oldest, keeping its name', () => {
        const legacy = createLegacyDb(dir);
        const oldestId = legacy.insertUser(' Ann@X.com', 'Ann', { created_date: '2025-01-01T00:00:00.000Z' });
        legacy.insertUser('ann@x.com', 'Annie', { created_date: '2025-02-01T00:00:00.000Z' });
        legacy.insertUser('bob@x.com', 'Bob');
        legacy.close();

        db = upgrade(dir);

        const users = db.prepare('SELECT id, email, full_name FROM users ORDER BY email').all();
        assert.deepEqual(users, [
            { id: oldestId, email: 'ann@x.com', full_name: 'Ann' },
            { id: users[1].id, email: 'bob@x.com', full_name: 'Bob' },
        ]);
    });

    test('a merged user without a name takes the first name in its group', () => {
        const legacy = createLegacyDb(dir);
        const oldestId = legacy.insertUser('CAROL@x.com', null, { created_date: '2025-01-01T00:00:00.000Z' });
        legacy.insertUser('carol@x.com', 'Carol', { created_date: '2025-02-01T00:00:00.000Z' });
        legacy.insertUser('Carol@x.com', 'Caz', { created_date: '2025-03-01T00:00:00.000Z' });
        legacy.close();

        db = upgrade(dir);

        assert.deepEqual(db.prepare('SELECT id, email, full_name FROM users').all(), [
            { id: oldestId, email: 'carol@x.com', full_name: 'Carol' },
        ]);
    });

    test('a user whose email is blank is dropped', () => {
        const legacy = createLegacyDb(dir);
        legacy.insertUser('   ', 'Nobody');
        legacy.close();

        db = upgrade(dir);

        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
    });

    test('rewrites player emails, room host emails and created_by in their canonical spelling', () => {
        const legacy = createLegacyDb(dir);
        const roomId = legacy.insertRecord(
            'GameRoom',
            { code: 'ABCD', host_email: ' Host@X.com' },
            { created_by: 'Host@X.com ', updated_date: '2025-07-01T00:00:00.000Z' },
        );
        const playerId = legacy.insertRecord('Player', { room_id: roomId, email: 'ANN@x.com ', name: 'Ann' });
        legacy.close();

        db = upgrade(dir);

        const room = readRecord(db, roomId);
        assert.equal(room.data.host_email, 'host@x.com');
        assert.equal(room.created_by, 'host@x.com');
        // A spelling fix isn't an edit, so the record's updated_date stays.
        assert.equal(room.updated_date, '2025-07-01T00:00:00.000Z');
        assert.deepEqual(readRecord(db, playerId).data, { room_id: roomId, email: 'ann@x.com', name: 'Ann' });
    });

    test('leaves records without an email string, and other entities, untouched', () => {
        const legacy = createLegacyDb(dir);
        const hostless = legacy.insertRecord('GameRoom', { code: 'WXYZ', host_email: null });
        const numberEmail = legacy.insertRecord('Player', { email: 42 });
        const otherEntity = legacy.insertRecord('Note', { email: 'Mixed@Case.com' });
        const before = legacy.db.prepare('SELECT id, data, created_by FROM records ORDER BY seq').all();
        legacy.close();

        db = upgrade(dir);

        const after = db.prepare('SELECT id, data, created_by FROM records ORDER BY seq').all();
        assert.deepEqual(after, before);
        assert.deepEqual(
            after.map((row) => row.id),
            [hostless, numberEmail, otherEntity],
        );
    });
});

// --- The database guarantee ----------------------------------------------------

describe('canonical emails after the upgrade', () => {
    let dir;

    beforeEach(() => {
        dir = makeTempDir();
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('the database refuses a user email that is not canonical', () => {
        const db = upgrade(dir);
        try {
            const insert = db.prepare(
                "INSERT INTO users (id, email, created_date, updated_date) VALUES (?, ?, 'now', 'now')",
            );
            assert.throws(() => insert.run('u1', 'A@x.com'), /CHECK constraint failed/);
            assert.throws(() => insert.run('u2', ' a@x.com'), /CHECK constraint failed/);
            assert.throws(() => insert.run('u3', ''), /CHECK constraint failed/);
            insert.run('u4', 'a@x.com');
        } finally {
            db.close();
        }
    });

    test('the store saves and finds users by the canonical spelling of any email', () => {
        const store = openStore(dir);
        try {
            const created = store.upsertUser(' Bob@X.com ', 'Bob');
            assert.equal(created.email, 'bob@x.com');

            assert.equal(store.findUserByEmail('BOB@x.com').id, created.id);
            assert.equal(store.upsertUser('bob@X.COM', null).id, created.id);
            assert.equal(store.setUserName(' bob@x.com', 'Robert').full_name, 'Robert');
        } finally {
            store.close();
        }
    });
});
