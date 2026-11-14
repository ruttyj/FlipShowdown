import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Database } from '../src/database/Database.js';
import { ENTITY_TABLES, StoreError } from '../src/database/entityTables.js';
import { TableRepository } from '../src/repositories/TableRepository.js';

// TableRepository: CRUD on one typed table, with records in the same shape the store has always
// returned. The store's own tests (store.test.js) cover the same behaviour through openStore.

const CREATOR = 'creator@example.com';

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-table-repository-'));
}

/** A resolveUserId over the real users table: finds the user by email or adds one with no name. */
function createUserResolver(database) {
    const findUser = database.prepare('SELECT id FROM users WHERE email = ?');
    const insertUser = database.prepare(
        "INSERT INTO users (id, email, full_name, created_date, updated_date) VALUES (?, ?, NULL, '', '')",
    );

    return (email) => {
        const existing = findUser.get(email);
        if (existing) {
            return existing.id;
        }
        const id = crypto.randomBytes(12).toString('hex');
        insertUser.run(id, email);
        return id;
    };
}

function countUsers(database) {
    return database.prepare('SELECT COUNT(*) AS count FROM users').get().count;
}

/** Asserts that `action` throws a StoreError with this status, code and (optionally) message. */
function assertStoreError(action, status, code, message) {
    assert.throws(action, (error) => {
        assert.ok(error instanceof StoreError, `expected a StoreError, got ${error}`);
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        if (message !== undefined) {
            assert.equal(error.message, message);
        }
        return true;
    });
}

// --- Construction ------------------------------------------------------------

describe('TableRepository construction', () => {
    let dir;
    let database;

    beforeEach(() => {
        dir = makeTempDir();
        database = Database.open(dir);
    });

    afterEach(() => {
        database.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('a table with a user reference refuses to be built without resolveUserId', () => {
        assert.throws(
            () => new TableRepository(database, ENTITY_TABLES.get('Player')),
            /players table has a user reference, so it needs resolveUserId/,
        );
    });

    test('a table without a user reference needs no resolveUserId', () => {
        const scores = new TableRepository(database, ENTITY_TABLES.get('RoundScore'));

        assert.deepEqual(scores.list(), []);
    });
});

// --- CRUD --------------------------------------------------------------------

describe('TableRepository on the game tables', () => {
    let dir;
    let database;
    let rooms;
    let players;
    let scores;
    let messages;

    beforeEach(() => {
        dir = makeTempDir();
        database = Database.open(dir);
        const resolveUserId = createUserResolver(database);
        rooms = new TableRepository(database, ENTITY_TABLES.get('GameRoom'), { resolveUserId });
        players = new TableRepository(database, ENTITY_TABLES.get('Player'), { resolveUserId });
        scores = new TableRepository(database, ENTITY_TABLES.get('RoundScore'));
        messages = new TableRepository(database, ENTITY_TABLES.get('ChatMessage'));
    });

    afterEach(() => {
        database.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function insertRoom(fields = {}) {
        return rooms.insert({ code: 'ABCD', status: 'waiting', ...fields }, CREATOR);
    }

    function insertPlayer(room, email, fields = {}) {
        return players.insert({ room_id: room.id, email, name: email, ...fields }, CREATOR);
    }

    // --- Insert and get --------------------------------------------------------

    test('insert returns the record as get reads it, every declared field present', () => {
        const message = messages.insert({ room_id: insertRoom().id, message: 'hi' }, CREATOR);

        assert.deepEqual(messages.get(message.id), message);
        assert.deepEqual(Object.keys(message), [
            'room_id',
            'sender_id',
            'recipient_id',
            'emoji',
            'message',
            'id',
            'created_date',
            'updated_date',
            'created_by',
        ]);
        assert.equal(message.emoji, null);
        assert.equal(message.created_by, CREATOR);
        assert.equal(message.created_date, message.updated_date);
        assert.match(message.id, /^[0-9a-f]{24}$/);
    });

    test('values come back with the types they were written with', () => {
        const room = insertRoom({ max_score: 200, is_edit_mode: false });
        const player = insertPlayer(room, 'ann@x.com', { is_host: true });
        const cards = [{ value: 7, type: 'number' }];

        const score = scores.insert({ room_id: room.id, player_id: player.id, cards, busted: true }, CREATOR);

        assert.equal(room.max_score, 200);
        assert.equal(room.is_edit_mode, false);
        assert.equal(player.is_host, true);
        assert.deepEqual(score.cards, cards);
        assert.equal(score.busted, true);
    });

    test('fields with no column are kept, and server-managed fields from the caller are ignored', () => {
        const room = insertRoom({ theme: 'dark', id: 'mine', created_by: 'someone@else.com' });

        assert.equal(room.theme, 'dark');
        assert.notEqual(room.id, 'mine');
        assert.equal(room.created_by, CREATOR);
    });

    test('a missing creator is stored as null', () => {
        const room = rooms.insert({ code: 'WXYZ' });

        assert.equal(room.created_by, null);
    });

    test('the user reference is stored as a user and read back as the canonical email', () => {
        const room = insertRoom({ host_email: ' Ann@X.com ' });
        const player = insertPlayer(room, 'ANN@x.com');

        assert.equal(room.host_email, 'ann@x.com');
        assert.equal(player.email, 'ann@x.com');
        assert.equal(countUsers(database), 1);
    });

    test('get returns null for an unknown id', () => {
        assert.equal(rooms.get('missing'), null);
    });

    // --- List and find ---------------------------------------------------------

    test('list gives every record oldest first with its seq', () => {
        const first = insertRoom({ code: 'AAAA' });
        const second = insertRoom({ code: 'BBBB' });

        const entries = rooms.list();

        assert.deepEqual(entries.map((entry) => entry.record), [first, second]);
        assert.ok(entries[0].seq < entries[1].seq);
    });

    test('find matches a column, the id, the user reference in any spelling, or a field with no column', () => {
        const room = insertRoom();
        const otherRoom = insertRoom({ code: 'WXYZ' });
        const ann = insertPlayer(room, 'ann@x.com', { team: 'red' });
        const bob = insertPlayer(room, 'bob@x.com');
        insertPlayer(otherRoom, 'ann@x.com');

        assert.deepEqual(players.find('room_id', room.id), [ann, bob]);
        assert.deepEqual(players.find('id', bob.id), [bob]);
        assert.deepEqual(players.find('email', ' BOB@x.com '), [bob]);
        assert.deepEqual(players.find('team', 'red'), [ann]);
        assert.deepEqual(players.find('room_id', 'missing'), []);
    });

    // --- Update ----------------------------------------------------------------

    test('update merges the changes, clears a field set to undefined and bumps updated_date', async () => {
        const room = insertRoom({ theme: 'dark', current_round: 1 });
        // Make sure the clock moves past created_date.
        await new Promise((resolve) => {
            setTimeout(resolve, 5);
        });

        const updated = rooms.update(room.id, { current_round: 2, theme: undefined, status: undefined });

        assert.equal(updated.current_round, 2);
        assert.equal(updated.code, 'ABCD');
        assert.equal(updated.status, null);
        assert.equal(Object.hasOwn(updated, 'theme'), false);
        assert.equal(updated.created_date, room.created_date);
        assert.ok(updated.updated_date > room.updated_date);
        assert.deepEqual(rooms.get(room.id), updated);
    });

    test('update keeps the user unless the reference field is written, and null points at no user', () => {
        const room = insertRoom({ host_email: 'ann@x.com' });

        const renamed = rooms.update(room.id, { code: 'WXYZ' });
        const unhosted = rooms.update(room.id, { host_email: null });

        assert.equal(renamed.host_email, 'ann@x.com');
        assert.equal(unhosted.host_email, null);
    });

    test('update returns null for an unknown id', () => {
        assert.equal(rooms.update('missing', { code: 'WXYZ' }), null);
    });

    // --- Delete ----------------------------------------------------------------

    test('delete returns the record as it was and cascades to its children', () => {
        const room = insertRoom();
        insertPlayer(room, 'ann@x.com');

        const deleted = rooms.delete(room.id);

        assert.deepEqual(deleted, room);
        assert.equal(rooms.get(room.id), null);
        assert.deepEqual(players.find('room_id', room.id), []);
    });

    test('delete returns null for an unknown id', () => {
        assert.equal(rooms.delete('missing'), null);
    });

    // --- Refused writes --------------------------------------------------------

    test('a second player for the same user in a room is a 409 conflict', () => {
        const room = insertRoom();
        insertPlayer(room, 'ann@x.com');

        assertStoreError(
            () => insertPlayer(room, 'Ann@X.com'),
            409,
            'conflict',
            'That user already has a player in this room',
        );
    });

    test('an update that breaks a unique constraint is a 409 conflict', () => {
        insertRoom({ code: 'AAAA' });
        const other = insertRoom({ code: 'BBBB' });

        assertStoreError(() => rooms.update(other.id, { code: 'AAAA' }), 409, 'conflict');
    });

    test('a player with no email is a 400 naming the field', () => {
        const room = insertRoom();

        assertStoreError(
            () => players.insert({ room_id: room.id, name: 'Nobody' }, CREATOR),
            400,
            'invalid_record',
            'email is required',
        );
    });

    test('a child of a room that does not exist is a 400', () => {
        assertStoreError(() => messages.insert({ room_id: 'missing', message: 'hi' }, CREATOR), 400, 'invalid_record');
    });

    test('a value of the wrong type is a 400 and writes nothing', () => {
        assertStoreError(() => rooms.insert({ max_score: 'lots' }, CREATOR), 400, 'invalid_record');

        assert.deepEqual(rooms.list(), []);
    });
});
