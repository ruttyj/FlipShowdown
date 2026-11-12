import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openDatabase, openStore } from '../src/db.js';
import { ENTITY_TABLES } from '../src/entityTables.js';
import { createLegacyDb } from './fixtures/legacyDb.js';
import { api, devLogin, startTestServer } from './helpers.js';

// Migration 0004: the game records a legacy database kept as JSON in `records` move into the typed
// tables. Rows that can't satisfy the new constraints go to `legacy_orphans` instead of being lost.

const CORE_ENTITIES = ['GameRoom', 'Player', 'RoundScore', 'ChatMessage'];

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-legacy-'));
}

/** The record the store should return for a legacy one: every declared field, as null when unset. */
function withDeclaredFields(entity, legacyRecord) {
    const spec = ENTITY_TABLES.get(entity);
    const record = {};
    for (const field of Object.keys(spec.columns)) {
        record[field] = null;
    }
    if (spec.userRef) {
        record[spec.userRef.field] = null;
    }
    return { ...record, ...legacyRecord };
}

/** Runs `read(db)` on a raw connection to the migrated database (store closed first). */
function readRaw(dir, read) {
    const db = openDatabase(dir);
    try {
        return read(db);
    } finally {
        db.close();
    }
}

function readOrphans(dir) {
    return readRaw(dir, (db) => db.prepare('SELECT * FROM legacy_orphans ORDER BY seq').all());
}

describe('moving legacy game records into the typed tables', () => {
    let dir;
    let legacy;
    let store;

    beforeEach(() => {
        dir = makeTempDir();
        legacy = createLegacyDb(dir);
    });

    afterEach(() => {
        store?.close();
        store = undefined;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    /** Closes the fixture and opens the store on its database, which runs the migrations. */
    function upgrade() {
        legacy.close();
        store = openStore(dir);
        return store;
    }

    function closeStore() {
        store.close();
        store = undefined;
    }

    // --- Moved rows ----------------------------------------------------------

    test('every game record reads back through the store as it did before, with the same types', () => {
        legacy.insertUser('ann@x.com', 'Ann');
        const roomId = legacy.insertRecord(
            'GameRoom',
            {
                code: 'ABCDEF',
                status: 'playing',
                host_email: 'ann@x.com',
                max_score: 200,
                current_round: 2,
                is_edit_mode: false,
                game_mode: 'classic',
                version: 7,
            },
            { created_by: 'ann@x.com', created_date: '2025-01-01T00:00:00.000Z', updated_date: '2025-01-02T00:00:00.000Z' },
        );
        const playerId = legacy.insertRecord('Player', {
            room_id: roomId,
            email: 'ann@x.com',
            name: 'Ann',
            is_host: true,
            has_submitted_round: false,
            total_score: 12,
            last_seen: null,
        });
        legacy.insertRecord('RoundScore', {
            room_id: roomId,
            player_id: playerId,
            round_number: 1,
            cards: [{ value: '12', type: 'number' }],
            base_sum: 12,
            final_score: 12,
            busted: false,
        });
        legacy.insertRecord('ChatMessage', { room_id: roomId, sender_id: playerId, recipient_id: null, message: '' });
        const before = legacy.readRecords();

        upgrade();

        for (const { entity, record } of before) {
            assert.deepEqual(store.getRecord(entity, record.id), withDeclaredFields(entity, record), entity);
        }
    });

    test('keeps the old insertion order, not the date order', () => {
        const roomId = legacy.insertRecord('GameRoom', { code: 'ABCDEF', status: 'waiting' });
        const otherRoomId = legacy.insertRecord('GameRoom', { code: 'GHJKLM', status: 'waiting' });
        const first = legacy.insertRecord(
            'Player',
            { room_id: roomId, email: 'b@x.com' },
            { created_date: '2025-03-01T00:00:00.000Z' },
        );
        legacy.insertRecord('Player', { room_id: otherRoomId, email: 'a@x.com' });
        const second = legacy.insertRecord(
            'Player',
            { room_id: roomId, email: 'a@x.com' },
            { created_date: '2025-01-01T00:00:00.000Z' },
        );

        upgrade();

        const ids = store.findRecords('Player', 'room_id', roomId).map((player) => player.id);
        assert.deepEqual(ids, [first, second]);
        const roomIds = store.listRecords('GameRoom').map((entry) => entry.record.id);
        assert.deepEqual(roomIds, [roomId, otherRoomId]);
    });

    test('a value of the wrong type survives in extra and a later write replaces it', () => {
        const roomId = legacy.insertRecord('GameRoom', {
            code: 'ABCDEF',
            status: 'waiting',
            max_score: '200',
            theme: 'dark',
            host_user_id: 'forged',
        });

        upgrade();

        const room = store.getRecord('GameRoom', roomId);
        assert.equal(room.max_score, '200');
        assert.equal(room.theme, 'dark');
        assert.equal('host_user_id' in room, false);
        const stored = readRaw(dir, (db) => db.prepare('SELECT max_score, extra FROM game_rooms').get());
        assert.deepEqual(stored, { max_score: null, extra: '{"max_score":"200","theme":"dark"}' });

        const updated = store.updateRecord('GameRoom', roomId, { max_score: 300 });
        assert.equal(updated.max_score, 300);
        assert.equal(updated.theme, 'dark');
    });

    test('creates a bare user for a player or host email nobody has signed in with', () => {
        legacy.insertUser('known@x.com', 'Known');
        const roomId = legacy.insertRecord('GameRoom', { code: 'ABCDEF', status: 'waiting', host_email: 'host@x.com' });
        legacy.insertRecord('Player', { room_id: roomId, email: 'new@x.com', name: 'New' });
        legacy.insertRecord('Player', { room_id: roomId, email: 'known@x.com', name: 'Known' });

        upgrade();

        assert.equal(store.findUserByEmail('host@x.com').full_name, null);
        assert.equal(store.findUserByEmail('new@x.com').full_name, null);
        assert.equal(store.findUserByEmail('known@x.com').full_name, 'Known');
        assert.deepEqual(
            store.findRecords('Player', 'room_id', roomId).map((player) => player.email),
            ['new@x.com', 'known@x.com'],
        );
        assert.equal(store.getRecord('GameRoom', roomId).host_email, 'host@x.com');
    });

    test('a room whose host email is not a usable string has no host and keeps the value in extra', () => {
        // 0002 already trimmed the blank one to ''.
        const blankHost = legacy.insertRecord('GameRoom', { code: 'ABCDEF', status: 'waiting', host_email: '  ' });
        const numberHost = legacy.insertRecord('GameRoom', { code: 'GHJKLM', status: 'waiting', host_email: 42 });

        upgrade();

        assert.equal(store.getRecord('GameRoom', blankHost).host_email, null);
        assert.equal(store.getRecord('GameRoom', numberHost).host_email, null);
        const extras = readRaw(dir, (db) => db.prepare('SELECT extra FROM game_rooms ORDER BY seq').all());
        assert.deepEqual(extras, [{ extra: '{"host_email":""}' }, { extra: '{"host_email":42}' }]);
    });

    // --- Orphans -------------------------------------------------------------

    test('rows that cannot keep their references move to legacy_orphans with a reason', () => {
        const roomId = legacy.insertRecord('GameRoom', { code: 'ABCDEF', status: 'playing' });
        const playerId = legacy.insertRecord('Player', { room_id: roomId, email: 'ann@x.com' });
        const lostPlayer = legacy.insertRecord('Player', { room_id: 'gone', email: 'bob@x.com' });
        const numberRoomPlayer = legacy.insertRecord('Player', { room_id: 7, email: 'bob@x.com' });
        const noEmail = legacy.insertRecord('Player', { room_id: roomId, name: 'Nobody' });
        const blankEmail = legacy.insertRecord('Player', { room_id: roomId, email: '' });
        const duplicate = legacy.insertRecord('Player', { room_id: roomId, email: 'ann@x.com', name: 'Ann again' });
        const duplicateScore = legacy.insertRecord('RoundScore', { room_id: roomId, player_id: duplicate });
        const lostRoomScore = legacy.insertRecord('RoundScore', { room_id: 'gone', player_id: playerId });
        const keptScore = legacy.insertRecord('RoundScore', { room_id: roomId, player_id: playerId });
        const lostChat = legacy.insertRecord('ChatMessage', { room_id: 'gone', message: 'hi' });
        const before = legacy.readRecords();

        upgrade();
        closeStore();

        const orphans = readOrphans(dir);
        assert.deepEqual(
            orphans.map((orphan) => [orphan.id, orphan.reason]),
            [
                [lostPlayer, 'missing_room'],
                [numberRoomPlayer, 'missing_room'],
                [noEmail, 'no_user'],
                [blankEmail, 'no_user'],
                [duplicate, 'duplicate_member'],
                [duplicateScore, 'missing_player'],
                [lostRoomScore, 'missing_room'],
                [lostChat, 'missing_room'],
            ],
        );

        // Each orphan keeps its original row, so nothing is lost.
        const legacyById = new Map(before.map((entry) => [entry.record.id, entry]));
        for (const orphan of orphans) {
            const original = legacyById.get(orphan.id);
            assert.equal(orphan.seq, original.seq);
            assert.equal(orphan.entity, original.entity);
            const { id, created_date, updated_date, created_by, ...data } = original.record;
            assert.deepEqual(JSON.parse(orphan.data), data);
            assert.deepEqual([orphan.created_date, orphan.updated_date, orphan.created_by], [created_date, updated_date, created_by]);
            assert.equal(orphan.id, id);
            assert.match(orphan.moved_date, /^\d{4}-\d{2}-\d{2}T/);
        }

        store = openStore(dir);
        assert.deepEqual(
            store.findRecords('RoundScore', 'room_id', roomId).map((score) => score.id),
            [keptScore],
        );
        assert.deepEqual(
            store.findRecords('Player', 'room_id', roomId).map((player) => player.id),
            [playerId],
        );
    });

    test('of rooms sharing an open code only the newest stays open', () => {
        const oldest = legacy.insertRecord('GameRoom', { code: 'ABCDEF', status: 'finished' });
        const alreadyClosed = legacy.insertRecord('GameRoom', { code: 'ABCDEF', status: 'closed' });
        const noStatus = legacy.insertRecord('GameRoom', { code: 'ABCDEF' });
        const newest = legacy.insertRecord('GameRoom', { code: 'ABCDEF', status: 'waiting' });
        const lonelyOpen = legacy.insertRecord('GameRoom', { code: 'GHJKLM', status: 'playing' });
        const newerButClosed = legacy.insertRecord('GameRoom', { code: 'GHJKLM', status: 'closed' });

        upgrade();

        const statusOf = (id) => store.getRecord('GameRoom', id).status;
        assert.equal(statusOf(oldest), 'closed');
        assert.equal(statusOf(alreadyClosed), 'closed');
        assert.equal(statusOf(noStatus), 'closed');
        assert.equal(statusOf(newest), 'waiting');
        assert.equal(statusOf(lonelyOpen), 'playing');
        assert.equal(statusOf(newerButClosed), 'closed');
    });

    // --- What's left behind --------------------------------------------------

    test('records keeps only the other entities, and loses the game-only indexes', () => {
        const roomId = legacy.insertRecord('GameRoom', { code: 'ABCDEF', status: 'waiting' });
        legacy.insertRecord('Player', { room_id: 'gone', email: 'ann@x.com' });
        const noteId = legacy.insertRecord('Note', { room_id: roomId, text: 'kept as is' });

        upgrade();
        closeStore();

        readRaw(dir, (db) => {
            const entities = db.prepare('SELECT DISTINCT entity FROM records').all().map((row) => row.entity);
            assert.deepEqual(entities, ['Note']);
            const indexes = db
                .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'records' ORDER BY name")
                .all()
                .map((row) => row.name);
            assert.deepEqual(indexes, ['records_entity_id', 'records_room_id']);
            assert.deepEqual(db.pragma('foreign_key_check'), []);
        });

        store = openStore(dir);
        assert.equal(store.getRecord('Note', noteId).text, 'kept as is');
        for (const entity of CORE_ENTITIES) {
            assert.ok(Array.isArray(store.listRecords(entity)));
        }
    });

    test('reopening the migrated database changes nothing', () => {
        const roomId = legacy.insertRecord('GameRoom', { code: 'ABCDEF', status: 'waiting', host_email: 'ann@x.com' });
        legacy.insertRecord('Player', { room_id: roomId, email: 'ann@x.com' });
        legacy.insertRecord('Player', { room_id: 'gone', email: 'bob@x.com' });

        upgrade();
        const players = store.listRecords('Player');
        closeStore();
        const orphanCount = readOrphans(dir).length;
        const backups = fs.readdirSync(path.join(dir, 'backups'));

        store = openStore(dir);

        assert.deepEqual(store.listRecords('Player'), players);
        assert.equal(readOrphans(dir).length, orphanCount);
        assert.deepEqual(fs.readdirSync(path.join(dir, 'backups')), backups);
    });
});

// --- End to end ------------------------------------------------------------------

describe('a legacy database behind the running server', () => {
    let server;

    afterEach(async () => {
        await server?.stop();
        server = undefined;
    });

    test('opens with its rooms intact, and game actions work on them', async () => {
        const dataDir = makeTempDir();
        const legacy = createLegacyDb(dataDir);
        legacy.insertUser('Host@Example.com', 'Host');
        const roomId = legacy.insertRecord(
            'GameRoom',
            {
                code: 'ABCDEF',
                status: 'waiting',
                host_email: 'Host@Example.com',
                max_score: 200,
                game_mode: 'classic',
                current_round: 1,
                current_turn_player_id: null,
                turn_passed_round: null,
                is_edit_mode: false,
                edit_mode_by: null,
                winner_player_id: null,
                finish_reason: null,
                game_number: 1,
                version: 2,
                // Recent, so the stale-room sweep at startup leaves it alone.
                last_activity_date: new Date().toISOString(),
            },
            { created_by: 'Host@Example.com' },
        );
        const hostPlayerId = legacy.insertRecord('Player', {
            room_id: roomId,
            email: 'HOST@example.com',
            name: 'Host',
            is_host: true,
            turn_order: 0,
            total_score: 0,
            current_round_score: 0,
            has_submitted_round: false,
            games_won: 0,
            last_seen: null,
        });
        legacy.db.prepare('UPDATE records SET data = json_set(data, ?, ?) WHERE id = ?').run('$.host_player_id', hostPlayerId, roomId);
        legacy.close();

        server = await startTestServer({ dataDir });
        const host = await devLogin(server.baseUrl, 'host@example.com', 'Host');
        const ann = await devLogin(server.baseUrl, 'ann@example.com', 'Ann');
        const action = (cookie, name, body = {}) => api(server.baseUrl, 'POST', `/api/rooms/${roomId}/actions/${name}`, { cookie, body });

        const found = await api(server.baseUrl, 'GET', '/api/rooms/by-code/ABCDEF', { cookie: host });
        assert.equal(found.status, 200);
        assert.equal(found.body.room.id, roomId);
        assert.equal(found.body.my_player.id, hostPlayerId);

        const joined = await action(ann, 'join', { name: 'Ann' });
        assert.equal(joined.status, 200);
        assert.equal(joined.body.already_joined, false);
        assert.equal((await action(host, 'start')).status, 200);

        const hand = (finalScore) => ({
            round_number: 1,
            cards: [{ value: String(finalScore), type: 'number' }],
            base_sum: finalScore,
            final_score: finalScore,
        });
        assert.equal((await action(host, 'submit-score', hand(5))).status, 200);
        assert.equal((await action(ann, 'submit-score', hand(9))).status, 200);

        const room = await api(server.baseUrl, 'GET', `/api/entities/GameRoom/${roomId}`, { cookie: host });
        assert.equal(room.body.current_round, 2);
        const players = await api(server.baseUrl, 'GET', `/api/entities/Player?q=${encodeURIComponent(JSON.stringify({ room_id: roomId }))}`, { cookie: host });
        const totals = players.body.map((player) => [player.email, player.total_score]);
        assert.deepEqual(totals.sort(), [['ann@example.com', 9], ['host@example.com', 5]]);
    });
});
