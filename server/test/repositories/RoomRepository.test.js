import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Database } from '../../src/database/Database.js';
import { StoreError } from '../../src/domain/errors.js';
import { RoomRepository } from '../../src/repositories/RoomRepository.js';
import { TableRepository } from '../../src/repositories/TableRepository.js';
import { UserRepository } from '../../src/repositories/UserRepository.js';

// RoomRepository: the game_rooms table. The shared CRUD is covered in tableRepository.test.js;
// these tests cover the named lookups, the atomic writes and the host user reference.

const CREATOR = 'creator@x.com';

function countUsers(database) {
    return database.prepare('SELECT COUNT(*) AS count FROM users').get().count;
}

/** Sets a room's stored created_date directly; the repository never lets a write change it. */
function setCreatedDate(database, roomId, createdDate) {
    database.prepare('UPDATE game_rooms SET created_date = ? WHERE id = ?').run(createdDate, roomId);
}

function assertConflict(action) {
    assert.throws(action, (error) => {
        assert.ok(error instanceof StoreError, `expected a StoreError, got ${error}`);
        assert.equal(error.status, 409);
        assert.equal(error.code, 'conflict');
        assert.equal(error.message, 'Another open room already uses this code');
        return true;
    });
}

describe('RoomRepository', () => {
    let dir;
    let database;
    let users;
    let rooms;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-room-repository-'));
        database = Database.open(dir);
        users = new UserRepository(database);
        rooms = new RoomRepository(database, { resolveUserId: users.resolveId });
    });

    afterEach(() => {
        database.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    // --- Construction ----------------------------------------------------------

    test('is a TableRepository over game_rooms', () => {
        assert.ok(rooms instanceof TableRepository);
        assert.equal(rooms.spec.table, 'game_rooms');
    });

    test('refuses to build without resolveUserId, since rooms reference their host', () => {
        assert.throws(() => new RoomRepository(database, {}), /game_rooms table has a user reference/);
    });

    // --- Records ---------------------------------------------------------------

    test('insert returns the room in the store record shape, with the host email canonical', () => {
        const room = rooms.insert({ code: 'ABCD', status: 'waiting', host_email: ' Host@X.com ', version: 0 }, CREATOR);

        assert.equal(room.code, 'ABCD');
        assert.equal(room.status, 'waiting');
        assert.equal(room.version, 0);
        assert.equal(room.is_edit_mode, null);
        assert.equal(room.host_email, 'host@x.com');
        assert.equal(room.created_by, CREATOR);
        assert.match(room.id, /^[0-9a-f]{24}$/);
        assert.deepEqual(rooms.get(room.id), room);
    });

    test('insert creates the host user through resolveUserId', () => {
        rooms.insert({ code: 'ABCD', host_email: 'host@x.com' }, CREATOR);

        const host = users.findByEmail('host@x.com');
        assert.notEqual(host, null);
        assert.equal(host.full_name, null);
    });

    test('a room may have no host', () => {
        const room = rooms.insert({ code: 'ABCD' }, CREATOR);

        assert.equal(room.host_email, null);
        assert.equal(countUsers(database), 0);
    });

    test('update merges changes and can move the host', () => {
        const room = rooms.insert({ code: 'ABCD', status: 'waiting', host_email: 'ann@x.com' }, CREATOR);

        const updated = rooms.update(room.id, { status: 'playing', host_email: 'bob@x.com' });

        assert.equal(updated.code, 'ABCD');
        assert.equal(updated.status, 'playing');
        assert.equal(updated.host_email, 'bob@x.com');
        assert.deepEqual(rooms.get(room.id), updated);
    });

    test('update returns null for an unknown room', () => {
        assert.equal(rooms.update('missing', { status: 'playing' }), null);
    });

    test('delete removes the room and returns it as it was', () => {
        const room = rooms.insert({ code: 'ABCD' }, CREATOR);

        assert.deepEqual(rooms.delete(room.id), room);
        assert.equal(rooms.get(room.id), null);
        assert.equal(rooms.delete(room.id), null);
    });

    // --- Atomic writes ---------------------------------------------------------

    test('insert of a second open room with the same code is a conflict and creates no host user', () => {
        rooms.insert({ code: 'ABCD', status: 'waiting' }, CREATOR);

        assertConflict(() => rooms.insert({ code: 'ABCD', status: 'waiting', host_email: 'new@x.com' }, CREATOR));

        assert.equal(users.findByEmail('new@x.com'), null);
        assert.equal(rooms.list().length, 1);
    });

    test('update to a code another open room uses is a conflict and creates no host user', () => {
        rooms.insert({ code: 'ABCD', status: 'waiting' }, CREATOR);
        const other = rooms.insert({ code: 'WXYZ', status: 'waiting' }, CREATOR);

        assertConflict(() => rooms.update(other.id, { code: 'ABCD', host_email: 'new@x.com' }));

        assert.equal(users.findByEmail('new@x.com'), null);
        assert.equal(rooms.get(other.id).code, 'WXYZ');
    });

    test('insert inside an outer transaction rolls back with it', () => {
        assert.throws(() => {
            database.transaction(() => {
                rooms.insert({ code: 'ABCD', host_email: 'host@x.com' }, CREATOR);
                throw new Error('later write failed');
            });
        }, /later write failed/);

        assert.deepEqual(rooms.list(), []);
        assert.equal(countUsers(database), 0);
    });

    test('a failed insert inside an outer transaction undoes only its own writes', () => {
        rooms.insert({ code: 'ABCD', status: 'waiting' }, CREATOR);

        const kept = database.transaction(() => {
            const room = rooms.insert({ code: 'EFGH', host_email: 'kept@x.com' }, CREATOR);
            assertConflict(() => rooms.insert({ code: 'ABCD', host_email: 'dropped@x.com' }, CREATOR));
            return room;
        });

        assert.equal(rooms.get(kept.id).host_email, 'kept@x.com');
        assert.equal(users.findByEmail('dropped@x.com'), null);
    });

    // --- findByCode ------------------------------------------------------------

    test('findByCode returns every room with the code, closed ones included, oldest first', () => {
        const closed = rooms.insert({ code: 'ABCD', status: 'closed' }, CREATOR);
        const open = rooms.insert({ code: 'ABCD', status: 'waiting' }, CREATOR);
        rooms.insert({ code: 'WXYZ', status: 'waiting' }, CREATOR);

        const found = rooms.findByCode('ABCD');

        assert.deepEqual(
            found.map((room) => room.id),
            [closed.id, open.id],
        );
    });

    test('findByCode returns an empty list for an unused code', () => {
        rooms.insert({ code: 'ABCD' }, CREATOR);

        assert.deepEqual(rooms.findByCode('ZZZZ'), []);
    });

    test('findByCode matches the code exactly', () => {
        rooms.insert({ code: 'ABCD' }, CREATOR);

        assert.deepEqual(rooms.findByCode('abcd'), []);
    });

    // --- listIdle --------------------------------------------------------------

    test('listIdle returns rooms whose last activity is before the cutoff, oldest first', () => {
        const old = rooms.insert({ code: 'AAAA', last_activity_date: '2026-01-01T00:00:00.000Z' }, CREATOR);
        rooms.insert({ code: 'BBBB', last_activity_date: '2026-06-01T00:00:00.000Z' }, CREATOR);
        const older = rooms.insert({ code: 'CCCC', last_activity_date: '2025-01-01T00:00:00.000Z' }, CREATOR);

        const idle = rooms.listIdle(Date.parse('2026-03-01T00:00:00.000Z'));

        assert.deepEqual(
            idle.map((room) => room.id),
            [old.id, older.id],
        );
        assert.deepEqual(idle[0], rooms.get(old.id));
    });

    test('listIdle does not count a room last touched exactly at the cutoff', () => {
        rooms.insert({ code: 'AAAA', last_activity_date: '2026-01-01T00:00:00.000Z' }, CREATOR);

        assert.deepEqual(rooms.listIdle(Date.parse('2026-01-01T00:00:00.000Z')), []);
    });

    test('listIdle falls back to created_date for a room with no last activity', () => {
        const neverPlayed = rooms.insert({ code: 'AAAA' }, CREATOR);
        const emptyActivity = rooms.insert({ code: 'BBBB', last_activity_date: '' }, CREATOR);
        const recent = rooms.insert({ code: 'CCCC' }, CREATOR);
        setCreatedDate(database, neverPlayed.id, '2026-01-01T00:00:00.000Z');
        setCreatedDate(database, emptyActivity.id, '2026-01-01T00:00:00.000Z');

        const idle = rooms.listIdle(Date.parse('2026-03-01T00:00:00.000Z'));

        assert.deepEqual(
            idle.map((room) => room.id),
            [neverPlayed.id, emptyActivity.id],
        );
        assert.equal(rooms.get(recent.id).last_activity_date, null);
    });

    test('listIdle never counts a room whose date does not parse', () => {
        rooms.insert({ code: 'AAAA', last_activity_date: 'not a date' }, CREATOR);

        assert.deepEqual(rooms.listIdle(Date.now() + 1000), []);
    });

    test('listIdle returns an empty list when there are no rooms', () => {
        assert.deepEqual(rooms.listIdle(Date.now()), []);
    });
});
