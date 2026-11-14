import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Database } from '../../src/database/Database.js';
import { UserRepository } from '../../src/repositories/UserRepository.js';

// UserRepository: the `users` table, with the email canonicalisation the store's user methods have
// (store.test.js and migrations.test.js cover the same behaviour through openStore).

function countUsers(database) {
    return database.prepare('SELECT COUNT(*) AS count FROM users').get().count;
}

describe('UserRepository', () => {
    let dir;
    let database;
    let users;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-user-repository-'));
        database = Database.open(dir);
        users = new UserRepository(database);
    });

    afterEach(() => {
        database.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    // --- findByEmail -----------------------------------------------------------

    test('findByEmail returns null for an unknown email', () => {
        assert.equal(users.findByEmail('nobody@x.com'), null);
    });

    test('findByEmail returns the raw row, matching any spelling of the email', () => {
        const created = users.upsert('ann@x.com', 'Ann');

        const found = users.findByEmail('  ANN@x.Com ');

        assert.deepEqual(found, created);
        assert.deepEqual(Object.keys(found).sort(), ['created_date', 'email', 'full_name', 'id', 'updated_date']);
    });

    test('findByEmail returns null for a non-string email', () => {
        assert.equal(users.findByEmail(undefined), null);
    });

    // --- upsert ----------------------------------------------------------------

    test('upsert inserts a new user with the canonical email', () => {
        const user = users.upsert(' Bob@X.com ', 'Bob');

        assert.equal(user.email, 'bob@x.com');
        assert.equal(user.full_name, 'Bob');
        assert.match(user.id, /^[0-9a-f]{24}$/);
        assert.equal(user.created_date, user.updated_date);
    });

    test('upsert stores no name when none is given', () => {
        assert.equal(users.upsert('bob@x.com').full_name, null);
        assert.equal(users.upsert('cat@x.com', '').full_name, null);
    });

    test('upsert keeps the stored name when given none or an empty one', () => {
        const created = users.upsert('bob@x.com', 'Bob');

        assert.deepEqual(users.upsert('BOB@x.com', null), created);
        assert.deepEqual(users.upsert('bob@x.com', ''), created);
        assert.equal(countUsers(database), 1);
    });

    test('upsert leaves the row untouched when given the same name', () => {
        const created = users.upsert('bob@x.com', 'Bob');

        assert.deepEqual(users.upsert('bob@x.com', 'Bob'), created);
    });

    test('upsert replaces the name when given a different one', () => {
        const created = users.upsert('bob@x.com', 'Bob');

        const updated = users.upsert('bob@x.com', 'Robert');

        assert.equal(updated.id, created.id);
        assert.equal(updated.full_name, 'Robert');
        assert.ok(updated.updated_date >= created.updated_date);
    });

    test('upsert of an empty email throws the CHECK failure', () => {
        assert.throws(() => users.upsert('   ', 'Nobody'), { code: 'SQLITE_CONSTRAINT_CHECK' });
        assert.equal(countUsers(database), 0);
    });

    // --- setName ---------------------------------------------------------------

    test('setName sets the name, matching any spelling of the email', () => {
        const created = users.upsert('bob@x.com', 'Bob');

        const renamed = users.setName(' BOB@x.com', 'Robert');

        assert.equal(renamed.id, created.id);
        assert.equal(renamed.full_name, 'Robert');
    });

    test('setName can clear the name', () => {
        users.upsert('bob@x.com', 'Bob');

        assert.equal(users.setName('bob@x.com', null).full_name, null);
    });

    test('setName returns null and adds nobody for an unknown email', () => {
        assert.equal(users.setName('nobody@x.com', 'Nobody'), null);
        assert.equal(countUsers(database), 0);
    });

    // --- resolveId -------------------------------------------------------------

    test('resolveId returns the id of an existing user, matching any spelling', () => {
        const created = users.upsert('ann@x.com', 'Ann');

        assert.equal(users.resolveId(' Ann@X.com '), created.id);
        assert.equal(users.findByEmail('ann@x.com').full_name, 'Ann');
        assert.equal(countUsers(database), 1);
    });

    test('resolveId creates a user with no name for a new email, once', () => {
        const id = users.resolveId('New@X.com');

        const created = users.findByEmail('new@x.com');
        assert.equal(created.id, id);
        assert.equal(created.email, 'new@x.com');
        assert.equal(created.full_name, null);
        assert.equal(users.resolveId('new@x.com'), id);
        assert.equal(countUsers(database), 1);
    });

    test('resolveId works detached from the repository, as a resolveUserId option', () => {
        const { resolveId } = users;

        const id = resolveId('ann@x.com');

        assert.equal(users.findByEmail('ann@x.com').id, id);
    });

    test('a later sign-in completes the name of a user resolveId created', () => {
        const id = users.resolveId('ann@x.com');

        const signedIn = users.upsert('ann@x.com', 'Ann');

        assert.equal(signedIn.id, id);
        assert.equal(signedIn.full_name, 'Ann');
    });

    test('resolveId rolls back with the transaction it runs in', () => {
        assert.throws(() => {
            database.transaction(() => {
                users.resolveId('ann@x.com');
                throw new Error('later write failed');
            });
        }, /later write failed/);

        assert.equal(users.findByEmail('ann@x.com'), null);
    });
});
