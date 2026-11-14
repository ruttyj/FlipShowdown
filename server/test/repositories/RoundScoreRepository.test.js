import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Database } from '../../src/database/Database.js';
import { openStore } from '../../src/database/db.js';
import { ENTITY_TABLES, StoreError } from '../../src/database/entityTables.js';
import { RoundScoreRepository } from '../../src/repositories/RoundScoreRepository.js';
import { TableRepository } from '../../src/repositories/TableRepository.js';

// RoundScoreRepository: the round_scores table with named reads. The CRUD it inherits is covered in
// depth by tableRepository.test.js; these tests check it is wired to the round_scores table, the
// named reads, and that they give what the store and the scoring code give today.

const CREATOR = 'creator@example.com';

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-round-score-repository-'));
}

/** A resolveUserId over the real users table, for the rooms and players the scores hang off. */
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

/** Asserts that `action` throws a StoreError with this status and code. */
function assertStoreError(action, status, code) {
    assert.throws(action, (error) => {
        assert.ok(error instanceof StoreError, `expected a StoreError, got ${error}`);
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        return true;
    });
}

function ids(records) {
    return records.map((record) => record.id);
}

describe('RoundScoreRepository', () => {
    let dir;
    let database;
    let rooms;
    let players;
    let scores;
    let room;
    let ann;
    let bob;

    beforeEach(() => {
        dir = makeTempDir();
        database = Database.open(dir);
        const resolveUserId = createUserResolver(database);
        rooms = new TableRepository(database, ENTITY_TABLES.get('GameRoom'), { resolveUserId });
        players = new TableRepository(database, ENTITY_TABLES.get('Player'), { resolveUserId });
        scores = new RoundScoreRepository(database);
        room = insertRoom('ROOM');
        ann = insertPlayer(room.id, 'ann@example.com');
        bob = insertPlayer(room.id, 'bob@example.com');
    });

    afterEach(() => {
        database.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function insertRoom(code) {
        return rooms.insert({ code, status: 'playing' }, CREATOR);
    }

    function insertPlayer(roomId, email) {
        return players.insert({ room_id: roomId, email, name: email }, CREATOR);
    }

    function insertScore(player, roundNumber, fields = {}) {
        return scores.insert({ room_id: player.room_id, player_id: player.id, round_number: roundNumber, ...fields }, CREATOR);
    }

    test('uses the round_scores table spec and needs no options', () => {
        assert.equal(scores.spec, ENTITY_TABLES.get('RoundScore'));
        assert.ok(scores instanceof TableRepository);
    });

    // --- get, insert, update, delete -------------------------------------------

    test('insert stores a score, cards and flags included, and get reads it back', () => {
        const cards = [{ value: 7 }, { modifier: 'x2' }];
        const score = insertScore(ann, 1, { cards, busted: false, base_sum: 7, final_score: 14 });

        assert.deepEqual(score.cards, cards);
        assert.equal(score.busted, false);
        assert.equal(score.final_score, 14);
        assert.equal(score.duplicate_allowed, null);
        assert.equal(score.created_by, CREATOR);
        assert.deepEqual(scores.get(score.id), score);
        assert.equal(scores.get('missing'), null);
    });

    test('insert refuses a bad type, an unknown player and a missing room', () => {
        assertStoreError(() => insertScore(ann, 'one'), 400, 'invalid_record');
        assertStoreError(() => scores.insert({ room_id: room.id, player_id: 'missing', round_number: 1 }), 400, 'invalid_record');
        assertStoreError(() => scores.insert({ player_id: ann.id, round_number: 1 }), 400, 'invalid_record');
    });

    test('update merges the changes and returns the record, or null for an unknown id', () => {
        const score = insertScore(ann, 1, { final_score: 5 });

        const updated = scores.update(score.id, { final_score: 9, busted: true });

        assert.equal(updated.final_score, 9);
        assert.equal(updated.busted, true);
        assert.equal(updated.round_number, 1);
        assert.deepEqual(scores.get(score.id), updated);
        assert.equal(scores.update('missing', { final_score: 1 }), null);
    });

    test('delete returns the score as it was, or null for an unknown id', () => {
        const score = insertScore(ann, 1);

        assert.deepEqual(scores.delete(score.id), score);
        assert.equal(scores.get(score.id), null);
        assert.equal(scores.delete(score.id), null);
    });

    // --- listByRoom --------------------------------------------------------------

    test('listByRoom gives only that room, oldest first, and [] for a room with none', () => {
        const otherRoom = insertRoom('OTHR');
        const carl = insertPlayer(otherRoom.id, 'carl@example.com');
        const second = insertScore(bob, 2);
        insertScore(carl, 1);
        const first = insertScore(ann, 1);

        assert.deepEqual(ids(scores.listByRoom(room.id)), [second.id, first.id]);
        assert.deepEqual(scores.listByRoom('missing'), []);
    });

    // --- findForRound ------------------------------------------------------------

    test('findForRound gives the player\'s score for that round, or null', () => {
        insertScore(ann, 1);
        const annRound2 = insertScore(ann, 2);
        insertScore(bob, 2);

        assert.deepEqual(scores.findForRound(room.id, ann.id, 2), annRound2);
        assert.equal(scores.findForRound(room.id, ann.id, 3), null);
        assert.equal(scores.findForRound(room.id, 'missing', 2), null);
        assert.equal(scores.findForRound('other-room', ann.id, 2), null);
    });

    test('findForRound gives the oldest score when a round has more than one', () => {
        const first = insertScore(ann, 1);
        insertScore(ann, 1);

        assert.equal(scores.findForRound(room.id, ann.id, 1).id, first.id);
    });

    test('findForRound only matches a round number with ===, as the scoring code does', () => {
        const unnumbered = insertScore(ann, null);
        insertScore(ann, 3);

        // SQLite would turn '3' into 3 when comparing with the INTEGER column.
        assert.equal(scores.findForRound(room.id, ann.id, '3'), null);
        assert.equal(scores.findForRound(room.id, ann.id, undefined), null);
        assert.equal(scores.findForRound(room.id, ann.id, null).id, unnumbered.id);
    });

    test('findForRound matches a legacy round number kept in extra by its record value', () => {
        // Migration 0004 keeps a value that didn't fit its column in `extra`; the record shows it.
        const legacy = insertScore(ann, null);
        database.prepare('UPDATE round_scores SET extra = ? WHERE id = ?').run('{"round_number":"2"}', legacy.id);

        assert.equal(scores.findForRound(room.id, ann.id, null), null);
        assert.equal(scores.findForRound(room.id, ann.id, '2').id, legacy.id);
    });
});

// --- Same results as the store -----------------------------------------------------

describe('RoundScoreRepository reads match the store', () => {
    let dir;

    beforeEach(() => {
        dir = makeTempDir();
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('listByRoom equals findRecords, and findForRound the scoring code\'s lookup', () => {
        const store = openStore(dir);
        const [room] = store.createRecords('GameRoom', [{ code: 'ROOM', status: 'playing' }], CREATOR);
        const [player] = store.createRecords('Player', [{ room_id: room.id, email: 'a@example.com', name: 'A' }], CREATOR);
        store.createRecords(
            'RoundScore',
            [
                { room_id: room.id, player_id: player.id, round_number: 2, cards: [1, 2], note: 'kept' },
                { room_id: room.id, player_id: player.id, round_number: 1, busted: true },
            ],
            CREATOR,
        );
        const storeByRoom = store.findRecords('RoundScore', 'room_id', room.id);
        store.close();

        // What scoring.js's findRoundScore does today: the room's scores, filtered in JS.
        const storeRound1 = storeByRoom.find((score) => score.player_id === player.id && score.round_number === 1);

        const database = Database.open(dir);
        try {
            const scores = new RoundScoreRepository(database);

            assert.deepEqual(scores.listByRoom(room.id), storeByRoom);
            assert.deepEqual(scores.findForRound(room.id, player.id, 1), storeRound1);
        } finally {
            database.close();
        }
    });
});
