import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Database } from '../../src/database/Database.js';
import { openStore } from '../../src/database/db.js';
import { ENTITY_TABLES, StoreError } from '../../src/database/entityTables.js';
import { PlayerRepository } from '../../src/repositories/PlayerRepository.js';
import { RoundScoreRepository } from '../../src/repositories/RoundScoreRepository.js';
import { TableRepository } from '../../src/repositories/TableRepository.js';

// PlayerRepository: the players table with named reads. The CRUD it inherits is covered in depth by
// tableRepository.test.js; these tests check it is wired to the players table, the named reads,
// and that the reads give what the store gives today for the same rows.

const CREATOR = 'creator@example.com';

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-player-repository-'));
}

/** A resolveUserId over the real users table (what UserRepository#resolveId does): find or add. */
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

function names(records) {
    return records.map((record) => record.name);
}

describe('PlayerRepository construction', () => {
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

    test('refuses to be built without resolveUserId', () => {
        assert.throws(() => new PlayerRepository(database), /players table has a user reference/);
        assert.throws(() => new PlayerRepository(database, {}), /players table has a user reference/);
    });

    test('uses the players table spec', () => {
        const players = new PlayerRepository(database, { resolveUserId: createUserResolver(database) });

        assert.equal(players.spec, ENTITY_TABLES.get('Player'));
        assert.ok(players instanceof TableRepository);
    });
});

describe('PlayerRepository', () => {
    let dir;
    let database;
    let rooms;
    let players;
    let room;

    beforeEach(() => {
        dir = makeTempDir();
        database = Database.open(dir);
        const resolveUserId = createUserResolver(database);
        rooms = new TableRepository(database, ENTITY_TABLES.get('GameRoom'), { resolveUserId });
        players = new PlayerRepository(database, { resolveUserId });
        room = insertRoom('ROOM');
    });

    afterEach(() => {
        database.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function insertRoom(code) {
        return rooms.insert({ code, status: 'waiting' }, CREATOR);
    }

    function insertPlayer(roomId, email, fields = {}) {
        return players.insert({ room_id: roomId, email, name: email, ...fields }, CREATOR);
    }

    // --- get, insert, update, delete -------------------------------------------

    test('insert stores a player with its email canonical, and get reads it back', () => {
        const player = insertPlayer(room.id, '  Ann@Example.COM ', { turn_order: 2, is_host: true });

        assert.equal(player.email, 'ann@example.com');
        assert.equal(player.turn_order, 2);
        assert.equal(player.is_host, true);
        assert.equal(player.created_by, CREATOR);
        assert.deepEqual(players.get(player.id), player);
    });

    test('get returns null for an unknown id', () => {
        assert.equal(players.get('missing'), null);
    });

    test('insert refuses a player with no email, a bad type, an unknown room or a second seat', () => {
        insertPlayer(room.id, 'ann@example.com');

        assertStoreError(() => players.insert({ room_id: room.id, name: 'x' }), 400, 'invalid_record', 'email is required');
        assertStoreError(
            () => insertPlayer(room.id, 'bob@example.com', { turn_order: 'first' }),
            400,
            'invalid_record',
            'turn_order must be a number',
        );
        assertStoreError(() => insertPlayer('no-such-room', 'bob@example.com'), 400, 'invalid_record');
        assertStoreError(
            () => insertPlayer(room.id, 'ANN@example.com'),
            409,
            'conflict',
            'That user already has a player in this room',
        );
    });

    test('update merges the changes and returns the record, or null for an unknown id', () => {
        const player = insertPlayer(room.id, 'ann@example.com', { total_score: 10 });

        const updated = players.update(player.id, { total_score: 25, last_seen: 'now', email: 'Zed@example.com' });

        assert.equal(updated.total_score, 25);
        assert.equal(updated.last_seen, 'now');
        assert.equal(updated.email, 'zed@example.com');
        assert.equal(updated.name, 'ann@example.com');
        assert.deepEqual(players.get(player.id), updated);
        assert.equal(players.update('missing', { total_score: 1 }), null);
    });

    test('delete returns the player as it was and removes its scores, or null for an unknown id', () => {
        const player = insertPlayer(room.id, 'ann@example.com');
        const scores = new RoundScoreRepository(database);
        scores.insert({ room_id: room.id, player_id: player.id, round_number: 1 }, CREATOR);

        assert.deepEqual(players.delete(player.id), player);
        assert.equal(players.get(player.id), null);
        assert.deepEqual(scores.listByRoom(room.id), []);
        assert.equal(players.delete(player.id), null);
    });

    // --- Named reads -------------------------------------------------------------

    test('listByRoom gives only that room, in joining order, and [] for a room with none', () => {
        const otherRoom = insertRoom('OTHR');
        insertPlayer(room.id, 'c@example.com', { turn_order: 0 });
        insertPlayer(otherRoom.id, 'x@example.com');
        insertPlayer(room.id, 'a@example.com', { turn_order: 2 });
        insertPlayer(room.id, 'b@example.com', { turn_order: 1 });

        assert.deepEqual(names(players.listByRoom(room.id)), ['c@example.com', 'a@example.com', 'b@example.com']);
        assert.deepEqual(names(players.listByRoom(otherRoom.id)), ['x@example.com']);
        assert.deepEqual(players.listByRoom('missing'), []);
    });

    test('listByRoomInTurnOrder sorts by turn_order, no turn_order as 0, ties in joining order', () => {
        insertPlayer(room.id, 'three@example.com', { turn_order: 3 });
        insertPlayer(room.id, 'none@example.com');
        insertPlayer(room.id, 'one@example.com', { turn_order: 1 });
        insertPlayer(room.id, 'zero@example.com', { turn_order: 0 });
        insertPlayer(room.id, 'minus@example.com', { turn_order: -1 });

        assert.deepEqual(names(players.listByRoomInTurnOrder(room.id)), [
            'minus@example.com',
            'none@example.com',
            'zero@example.com',
            'one@example.com',
            'three@example.com',
        ]);
        assert.deepEqual(players.listByRoomInTurnOrder('missing'), []);
    });

    test('listByRoomInTurnOrder sorts a legacy turn_order kept in extra by its record value', () => {
        // Migration 0004 keeps a value that didn't fit its column in `extra`; the record shows it.
        const legacy = insertPlayer(room.id, 'legacy@example.com');
        insertPlayer(room.id, 'one@example.com', { turn_order: 1 });
        database.prepare('UPDATE players SET extra = ? WHERE id = ?').run('{"turn_order":5}', legacy.id);

        assert.deepEqual(names(players.listByRoomInTurnOrder(room.id)), ['one@example.com', 'legacy@example.com']);
    });

    test('listByUserEmail finds the user in every room, in any spelling, and [] for a stranger', () => {
        const otherRoom = insertRoom('OTHR');
        const first = insertPlayer(room.id, 'ann@example.com');
        insertPlayer(room.id, 'bob@example.com');
        const second = insertPlayer(otherRoom.id, 'ann@example.com');

        const found = players.listByUserEmail(' ANN@Example.com ');

        assert.deepEqual(found, [first, second]);
        assert.deepEqual(players.listByUserEmail('nobody@example.com'), []);
    });
});

// --- Same results as the store -----------------------------------------------------

describe('PlayerRepository reads match the store', () => {
    let dir;

    beforeEach(() => {
        dir = makeTempDir();
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('listByRoom and listByUserEmail equal findRecords and findRecordsByEmail', () => {
        const store = openStore(dir);
        const [room] = store.createRecords('GameRoom', [{ code: 'ROOM', status: 'waiting' }], CREATOR);
        store.createRecords(
            'Player',
            [
                { room_id: room.id, email: 'b@example.com', name: 'B', turn_order: 1 },
                { room_id: room.id, email: 'a@example.com', name: 'A', turn_order: 0, extra_field: 'kept' },
            ],
            CREATOR,
        );
        const storeByRoom = store.findRecords('Player', 'room_id', room.id);
        const storeByEmail = store.findRecordsByEmail('Player', 'a@example.com');
        store.close();

        const database = Database.open(dir);
        try {
            const players = new PlayerRepository(database, { resolveUserId: createUserResolver(database) });

            assert.deepEqual(players.listByRoom(room.id), storeByRoom);
            assert.deepEqual(players.listByUserEmail('a@example.com'), storeByEmail);
            assert.deepEqual(names(players.listByRoomInTurnOrder(room.id)), ['A', 'B']);
        } finally {
            database.close();
        }
    });
});
