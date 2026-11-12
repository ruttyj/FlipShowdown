import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { openStore } from '../src/db.js';
import { StoreError, toStoreError } from '../src/entityTables.js';

// The store on its typed tables (migration 0003): GameRoom, Player, RoundScore and ChatMessage
// keep the record shape they had as JSON, with typed columns, foreign keys and uniqueness checks
// underneath. Other entities still go to the generic `records` table.

const CREATOR = 'creator@example.com';

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-store-'));
}

function createOne(store, entity, fields) {
    const [record] = store.createRecords(entity, [fields], CREATOR);
    return record;
}

function createRoom(store, fields = {}) {
    return createOne(store, 'GameRoom', { code: 'ABCD', status: 'waiting', ...fields });
}

function createPlayer(store, room, email, fields = {}) {
    return createOne(store, 'Player', { room_id: room.id, email, name: email, ...fields });
}

function createScore(store, room, player, fields = {}) {
    return createOne(store, 'RoundScore', { room_id: room.id, player_id: player.id, round_number: 1, ...fields });
}

function countUsers(dir) {
    const db = new Database(path.join(dir, 'flip7.db'), { readonly: true });
    try {
        return db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    } finally {
        db.close();
    }
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

describe('store on the typed tables', () => {
    let dir;
    let store;

    beforeEach(() => {
        dir = makeTempDir();
        store = openStore(dir);
    });

    afterEach(() => {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    // --- Record shape -----------------------------------------------------------

    test('booleans, numbers and cards come back with the types they were written with', () => {
        const room = createRoom(store, { max_score: 200, is_edit_mode: false, current_round: 3 });
        const player = createPlayer(store, room, 'ann@x.com', { is_host: true, total_score: 0, turn_order: 1.5 });
        const cards = [{ value: 7, type: 'number' }, { value: 'x2', type: 'modifier' }];
        const score = createScore(store, room, player, { cards, busted: true, final_score: -3 });

        const storedRoom = store.getRecord('GameRoom', room.id);
        assert.equal(storedRoom.max_score, 200);
        assert.equal(storedRoom.is_edit_mode, false);
        assert.equal(storedRoom.current_round, 3);

        const storedPlayer = store.getRecord('Player', player.id);
        assert.equal(storedPlayer.is_host, true);
        assert.equal(storedPlayer.total_score, 0);
        assert.equal(storedPlayer.turn_order, 1.5);

        const storedScore = store.getRecord('RoundScore', score.id);
        assert.deepEqual(storedScore.cards, cards);
        assert.equal(storedScore.busted, true);
        assert.equal(storedScore.final_score, -3);
    });

    test('create returns the record as a later read gives it', () => {
        const room = createRoom(store, { max_score: 200 });

        assert.deepEqual(room, store.getRecord('GameRoom', room.id));
        assert.equal(room.created_by, CREATOR);
        assert.equal(typeof room.id, 'string');
        assert.equal(room.created_date, room.updated_date);
    });

    test('unknown fields round-trip, nested values included', () => {
        const room = createRoom(store, { theme: 'dark', settings: { sound: false, volume: [1, 2] } });

        const stored = store.getRecord('GameRoom', room.id);
        assert.equal(stored.theme, 'dark');
        assert.deepEqual(stored.settings, { sound: false, volume: [1, 2] });
    });

    test('a "__proto__" field stays plain data', () => {
        const fields = JSON.parse('{ "code": "PROTO", "__proto__": { "polluted": true } }');
        const room = createRoom(store, fields);

        const stored = store.getRecord('GameRoom', room.id);
        assert.equal(stored.polluted, undefined);
        assert.ok(Object.hasOwn(stored, '__proto__'));
        assert.equal(Object.getPrototypeOf(stored), Object.prototype);
    });

    test('declared fields that were never set read as null', () => {
        const room = createRoom(store);
        const player = createPlayer(store, room, 'ann@x.com');

        const storedRoom = store.getRecord('GameRoom', room.id);
        assert.equal(storedRoom.max_score, null);
        assert.equal(storedRoom.host_email, null);
        assert.equal(storedRoom.winner_player_id, null);

        const storedPlayer = store.getRecord('Player', player.id);
        assert.equal(storedPlayer.games_won, null);
        assert.equal(storedPlayer.has_submitted_round, null);
    });

    test('client values for server fields and user ids are discarded', () => {
        const room = createRoom(store, {
            id: 'forged-id',
            created_date: '1999-01-01T00:00:00.000Z',
            created_by: 'someone@else.com',
            host_user_id: 'forged-user',
        });

        assert.notEqual(room.id, 'forged-id');
        assert.notEqual(room.created_date, '1999-01-01T00:00:00.000Z');
        assert.equal(room.created_by, CREATOR);
        assert.equal(Object.hasOwn(room, 'host_user_id'), false);
    });

    // --- Order --------------------------------------------------------------------

    test('lists and finds come back in insertion order, with seq increasing', () => {
        const room = createRoom(store);
        const first = createPlayer(store, room, 'b@x.com');
        const second = createPlayer(store, room, 'a@x.com');
        const third = createPlayer(store, room, 'c@x.com');

        const found = store.findRecords('Player', 'room_id', room.id);
        assert.deepEqual(found.map((player) => player.id), [first.id, second.id, third.id]);

        const listed = store.listRecords('Player');
        assert.deepEqual(listed.map((entry) => entry.record.id), [first.id, second.id, third.id]);
        assert.ok(listed[0].seq < listed[1].seq && listed[1].seq < listed[2].seq);
    });

    test('findRecords matches by id, by a declared field, by email and by an unknown field', () => {
        const room = createRoom(store, { code: 'WXYZ', theme: 'dark' });
        createRoom(store, { code: 'OTHER', status: 'waiting' });
        const player = createPlayer(store, room, 'ann@x.com');

        assert.deepEqual(store.findRecords('GameRoom', 'id', room.id), [room]);
        assert.deepEqual(store.findRecords('GameRoom', 'code', 'WXYZ'), [room]);
        assert.deepEqual(store.findRecords('GameRoom', 'theme', 'dark'), [room]);
        assert.deepEqual(store.findRecords('Player', 'email', ' Ann@X.com'), [player]);
        assert.deepEqual(store.findRecords('GameRoom', 'host_email', 'nobody@x.com'), []);
        assert.deepEqual(store.findRecords('GameRoom', 'code', 'NONE'), []);
    });

    // --- Updates and deletes ----------------------------------------------------

    test('an update merges into the record and undefined clears a field', () => {
        const room = createRoom(store, { max_score: 200, theme: 'dark', mood: 'calm' });

        const updated = store.updateRecord('GameRoom', room.id, {
            status: 'playing',
            max_score: undefined,
            theme: undefined,
            mood: 'tense',
        });

        assert.equal(updated.code, 'ABCD');
        assert.equal(updated.status, 'playing');
        assert.equal(updated.max_score, null);
        assert.equal(Object.hasOwn(updated, 'theme'), false);
        assert.equal(updated.mood, 'tense');
        assert.equal(updated.created_date, room.created_date);
        assert.deepEqual(updated, store.getRecord('GameRoom', room.id));
    });

    test('an update can move a player to another user', () => {
        const room = createRoom(store);
        const player = createPlayer(store, room, 'ann@x.com');

        const updated = store.updateRecord('Player', player.id, { email: 'Bob@X.com' });

        assert.equal(updated.email, 'bob@x.com');
        assert.deepEqual(store.findRecordsByEmail('Player', 'ann@x.com'), []);
    });

    test('updating or deleting a missing record returns null', () => {
        assert.equal(store.updateRecord('GameRoom', 'missing', { status: 'closed' }), null);
        assert.equal(store.deleteRecord('GameRoom', 'missing'), null);
    });

    test('a delete returns the record as it was', () => {
        const room = createRoom(store, { theme: 'dark' });

        const deleted = store.deleteRecord('GameRoom', room.id);

        assert.deepEqual(deleted, room);
        assert.equal(store.getRecord('GameRoom', room.id), null);
    });

    test('deleting a room also deletes its players, scores and chat', () => {
        const room = createRoom(store);
        const otherRoom = createRoom(store, { code: 'KEEP' });
        const player = createPlayer(store, room, 'ann@x.com');
        const otherPlayer = createPlayer(store, otherRoom, 'ann@x.com');
        const score = createScore(store, room, player);
        const message = createOne(store, 'ChatMessage', { room_id: room.id, sender_id: player.id, message: 'hi' });

        store.deleteRecord('GameRoom', room.id);

        assert.equal(store.getRecord('Player', player.id), null);
        assert.equal(store.getRecord('RoundScore', score.id), null);
        assert.equal(store.getRecord('ChatMessage', message.id), null);
        assert.deepEqual(store.getRecord('Player', otherPlayer.id), otherPlayer);
    });

    test('deleting a player also deletes their scores, but not the chat they sent', () => {
        const room = createRoom(store);
        const player = createPlayer(store, room, 'ann@x.com');
        const otherPlayer = createPlayer(store, room, 'bob@x.com');
        const score = createScore(store, room, player);
        const otherScore = createScore(store, room, otherPlayer);
        const message = createOne(store, 'ChatMessage', { room_id: room.id, sender_id: player.id, message: 'hi' });

        store.deleteRecord('Player', player.id);

        assert.equal(store.getRecord('RoundScore', score.id), null);
        assert.deepEqual(store.getRecord('RoundScore', otherScore.id), otherScore);
        assert.deepEqual(store.getRecord('ChatMessage', message.id), message);
    });

    // --- Users --------------------------------------------------------------------

    test('a player email creates its user when needed and reads back canonical', () => {
        const room = createRoom(store, { host_email: ' Host@X.com' });
        const player = createPlayer(store, room, ' Dave@X.com ');

        assert.equal(player.email, 'dave@x.com');
        assert.equal(room.host_email, 'host@x.com');
        const user = store.findUserByEmail('dave@x.com');
        assert.equal(user.email, 'dave@x.com');
        assert.equal(user.full_name, null);
        assert.equal(Object.hasOwn(player, 'user_id'), false);
    });

    test('a player of an existing user points at that user, who keeps their name', () => {
        store.upsertUser('ann@x.com', 'Ann');
        const room = createRoom(store);

        createPlayer(store, room, 'ann@x.com');

        assert.equal(countUsers(dir), 1);
        assert.equal(store.findUserByEmail('ann@x.com').full_name, 'Ann');
    });

    test('findRecordsByEmail finds a user\'s players in every room', () => {
        const room = createRoom(store);
        const otherRoom = createRoom(store, { code: 'EFGH' });
        const first = createPlayer(store, room, 'ann@x.com');
        createPlayer(store, room, 'bob@x.com');
        const second = createPlayer(store, otherRoom, 'ann@x.com');

        const found = store.findRecordsByEmail('Player', 'ann@x.com');

        assert.deepEqual(found.map((player) => player.id), [first.id, second.id]);
        assert.deepEqual(store.findRecordsByEmail('GameRoom', 'ann@x.com'), []);
    });

    // --- Constraint violations ------------------------------------------------

    test('a player without an email is rejected with a 400', () => {
        const room = createRoom(store);

        assertStoreError(() => createOne(store, 'Player', { room_id: room.id, name: 'Nobody' }), 400, 'invalid_record');
        assertStoreError(() => createPlayer(store, room, null), 400, 'invalid_record');
    });

    test('a malformed email is rejected with a 400', () => {
        const room = createRoom(store);

        assertStoreError(() => createPlayer(store, room, 'not an email'), 400, 'invalid_record');
        assertStoreError(() => createPlayer(store, room, 42), 400, 'invalid_record');
        assertStoreError(() => createRoom(store, { code: 'BAD', host_email: 'nope' }), 400, 'invalid_record');
    });

    test('a record in an unknown room is rejected with a 400', () => {
        assertStoreError(() => createOne(store, 'Player', { room_id: 'no-such-room', email: 'ann@x.com' }), 400, 'invalid_record');
        assertStoreError(() => createOne(store, 'ChatMessage', { sender_id: 'p1', message: 'hi' }), 400, 'invalid_record');
    });

    test('a score of an unknown player is rejected with a 400', () => {
        const room = createRoom(store);

        assertStoreError(() => createOne(store, 'RoundScore', { room_id: room.id, player_id: 'ghost' }), 400, 'invalid_record');
    });

    test('the same user twice in one room is a 409', () => {
        const room = createRoom(store);
        createPlayer(store, room, 'ann@x.com');

        assertStoreError(() => createPlayer(store, room, 'ANN@x.com'), 409, 'conflict');
    });

    test('a second open room with the same code is a 409, but not once the first is closed', () => {
        const first = createRoom(store, { code: 'SAME', status: 'playing' });

        assertStoreError(() => createRoom(store, { code: 'SAME', status: 'waiting' }), 409, 'conflict');

        store.updateRecord('GameRoom', first.id, { status: 'closed' });
        const second = createRoom(store, { code: 'SAME', status: 'waiting' });
        assert.equal(second.code, 'SAME');
    });

    test('an update that breaks a constraint is a StoreError and changes nothing', () => {
        const room = createRoom(store);
        createPlayer(store, room, 'ann@x.com');
        const bob = createPlayer(store, room, 'bob@x.com');

        assertStoreError(() => store.updateRecord('Player', bob.id, { email: 'ann@x.com' }), 409, 'conflict');
        assertStoreError(() => store.updateRecord('Player', bob.id, { room_id: 'nowhere' }), 400, 'invalid_record');
        assertStoreError(() => store.updateRecord('Player', bob.id, { email: 'new@x.com', room_id: 'nowhere' }), 400, 'invalid_record');

        assert.deepEqual(store.getRecord('Player', bob.id), bob);
        assert.equal(store.findUserByEmail('new@x.com'), null);
    });

    test('a value of the wrong type for a declared field is a 400', () => {
        assertStoreError(() => createRoom(store, { max_score: '200' }), 400, 'invalid_record');
        assertStoreError(() => createRoom(store, { is_edit_mode: 1 }), 400, 'invalid_record');
        assertStoreError(() => createRoom(store, { code: 1234 }), 400, 'invalid_record');

        const room = createRoom(store);
        assertStoreError(() => store.updateRecord('GameRoom', room.id, { max_score: 'lots' }), 400, 'invalid_record');
    });

    test('numbers JSON could not hold are stored as null, as they were before', () => {
        const room = createRoom(store, { max_score: Number.NaN, current_round: Number.POSITIVE_INFINITY });

        assert.equal(room.max_score, null);
        assert.equal(room.current_round, null);
    });

    test('a bulk create with a bad item leaves nothing behind, not even a new user', () => {
        const room = createRoom(store);
        const usersBefore = countUsers(dir);

        assertStoreError(
            () =>
                store.createRecords(
                    'Player',
                    [
                        { room_id: room.id, email: 'new@x.com' },
                        { room_id: room.id, email: 'other@x.com', total_score: 'ten' },
                    ],
                    CREATOR,
                ),
            400,
            'invalid_record',
        );

        assert.deepEqual(store.findRecords('Player', 'room_id', room.id), []);
        assert.equal(countUsers(dir), usersBefore);
    });

    test('a constraint error inside a transaction rolls the whole transaction back', () => {
        const room = createRoom(store);

        assert.throws(() =>
            store.transaction(() => {
                store.updateRecord('GameRoom', room.id, { status: 'playing' });
                createOne(store, 'Player', { room_id: 'nowhere', email: 'ann@x.com' });
            }),
        StoreError);

        assert.equal(store.getRecord('GameRoom', room.id).status, 'waiting');
    });

    // --- Other entities -----------------------------------------------------------

    test('an entity added through ENTITIES still works through the records table', () => {
        const note = createOne(store, 'Note', { room_id: 'anything', text: 'hello', pinned: true });

        assert.deepEqual(store.getRecord('Note', note.id), note);
        assert.deepEqual(store.findRecords('Note', 'room_id', 'anything'), [note]);
        assert.deepEqual(store.findRecords('Note', 'text', 'hello'), [note]);
        assert.deepEqual(store.listRecords('Note').map((entry) => entry.record), [note]);

        const updated = store.updateRecord('Note', note.id, { text: 'changed' });
        assert.equal(updated.text, 'changed');
        assert.equal(updated.pinned, true);

        assert.deepEqual(store.deleteRecord('Note', note.id), updated);
        assert.equal(store.getRecord('Note', note.id), null);
    });

    test('findRecordsByEmail on another entity matches emails by the shared canonical spelling', () => {
        // SQLite's lower() folds ASCII only, so it would miss the "Ä" here.
        const note = createOne(store, 'Note', { email: ' ÄNN@x.com ' });
        createOne(store, 'Note', { email: 42 });

        assert.deepEqual(store.findRecordsByEmail('Note', 'änn@x.com'), [note]);
        assert.deepEqual(store.findRecords('Note', 'code', 'none'), []);
    });
});

// --- Mapping SQLite errors -----------------------------------------------------

describe('toStoreError', () => {
    function sqliteError(code, message) {
        const error = new Error(message);
        error.code = code;
        return error;
    }

    test('maps any other UNIQUE violation to a generic 409', () => {
        const error = toStoreError(sqliteError('SQLITE_CONSTRAINT_UNIQUE', 'UNIQUE constraint failed: chat_messages.id'));

        assert.ok(error instanceof StoreError);
        assert.equal(error.status, 409);
        assert.equal(error.code, 'conflict');
    });

    test('maps CHECK and other NOT NULL violations to a 400 naming the field', () => {
        const check = toStoreError(sqliteError('SQLITE_CONSTRAINT_CHECK', 'CHECK constraint failed: busted IN (0, 1)'));
        assert.equal(check.status, 400);
        assert.equal(check.code, 'invalid_record');

        const notNull = toStoreError(sqliteError('SQLITE_CONSTRAINT_NOTNULL', 'NOT NULL constraint failed: players.room_id'));
        assert.equal(notNull.status, 400);
        assert.match(notNull.message, /room_id is required/);
    });

    test('returns anything that is not a constraint violation unchanged', () => {
        const busy = sqliteError('SQLITE_BUSY', 'database is locked');
        const plain = new TypeError('boom');

        assert.equal(toStoreError(busy), busy);
        assert.equal(toStoreError(plain), plain);
    });

    test('toBody gives the message and code', () => {
        const error = new StoreError(400, 'invalid_record', 'max_score must be a number');

        assert.deepEqual(error.toBody(), { message: 'max_score must be a number', code: 'invalid_record' });
    });
});
