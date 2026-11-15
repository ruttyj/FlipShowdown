import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Database } from '../../src/database/Database.js';
import { StoreError } from '../../src/domain/errors.js';
import { ChatMessageRepository } from '../../src/repositories/ChatMessageRepository.js';
import { EntityGateway } from '../../src/repositories/EntityGateway.js';
import { PlayerRepository } from '../../src/repositories/PlayerRepository.js';
import { RecordRepository } from '../../src/repositories/RecordRepository.js';
import { RoomRepository } from '../../src/repositories/RoomRepository.js';
import { RoundScoreRepository } from '../../src/repositories/RoundScoreRepository.js';
import { UserRepository } from '../../src/repositories/UserRepository.js';

// EntityGateway: the store's record API by entity name. The four game entities go to their
// table's repository and any other entity to RecordRepository. The store tests (store.test.js and
// the entities API tests) cover the same behaviour through openStore.

const CREATOR = 'creator@example.com';

// --- Routing -------------------------------------------------------------

/**
 * A repository stand-in that records each call as [method, ...args] in `calls` and returns
 * `result`.
 */
function createRecorder(calls, result) {
    const methods = ['list', 'find', 'findByEmail', 'get', 'insert', 'update', 'delete'];
    const recorder = {};
    for (const method of methods) {
        recorder[method] = (...args) => {
            calls.push([method, ...args]);
            return result;
        };
    }
    return recorder;
}

/** Calls every gateway method once for `entity`. */
function callEveryMethod(gateway, entity) {
    gateway.list(entity);
    gateway.find(entity, 'room_id', 'room-1');
    gateway.findByEmail(entity, 'a@example.com');
    gateway.get(entity, 'id-1');
    gateway.insert(entity, { name: 'x' }, CREATOR);
    gateway.update(entity, 'id-1', { name: 'y' });
    gateway.delete(entity, 'id-1');
}

describe('EntityGateway routing', () => {
    const fakeDatabase = { transaction: (fn) => fn() };

    function createGateway(calls) {
        return new EntityGateway(fakeDatabase, {
            rooms: createRecorder(calls.GameRoom, 'room'),
            players: createRecorder(calls.Player, 'player'),
            roundScores: createRecorder(calls.RoundScore, 'score'),
            chatMessages: createRecorder(calls.ChatMessage, 'chat'),
            records: createRecorder(calls.records, 'record'),
        });
    }

    function emptyCalls() {
        return { GameRoom: [], Player: [], RoundScore: [], ChatMessage: [], records: [] };
    }

    for (const entity of ['GameRoom', 'Player', 'RoundScore', 'ChatMessage']) {
        test(`${entity} goes to its own table's repository, without the entity name`, () => {
            const calls = emptyCalls();
            const gateway = createGateway(calls);

            callEveryMethod(gateway, entity);

            assert.deepEqual(calls[entity], [
                ['list'],
                ['find', 'room_id', 'room-1'],
                // A typed table has no findByEmail: its `email` field is matched by find.
                ['find', 'email', 'a@example.com'],
                ['get', 'id-1'],
                ['insert', { name: 'x' }, CREATOR],
                ['update', 'id-1', { name: 'y' }],
                ['delete', 'id-1'],
            ]);
            const others = Object.entries(calls).filter(([name]) => name !== entity);
            for (const [name, otherCalls] of others) {
                assert.deepEqual(otherCalls, [], `${name} should not be called`);
            }
        });
    }

    test('any other entity goes to RecordRepository, with the entity name', () => {
        const calls = emptyCalls();
        const gateway = createGateway(calls);

        callEveryMethod(gateway, 'Note');

        assert.deepEqual(calls.records, [
            ['list', 'Note'],
            ['find', 'Note', 'room_id', 'room-1'],
            ['findByEmail', 'Note', 'a@example.com'],
            ['get', 'Note', 'id-1'],
            ['insert', 'Note', { name: 'x' }, CREATOR],
            ['update', 'Note', 'id-1', { name: 'y' }],
            ['delete', 'Note', 'id-1'],
        ]);
        assert.deepEqual(calls.GameRoom, []);
        assert.deepEqual(calls.Player, []);
    });

    test('each method returns what the repository returned', () => {
        const gateway = createGateway(emptyCalls());

        assert.equal(gateway.get('GameRoom', 'id-1'), 'room');
        assert.equal(gateway.update('ChatMessage', 'id-1', {}), 'chat');
        assert.equal(gateway.delete('Note', 'id-1'), 'record');
        assert.deepEqual(gateway.insertMany('RoundScore', [{}, {}], CREATOR), ['score', 'score']);
    });
});

// --- Over a real database ------------------------------------------------

describe('EntityGateway over a real database', () => {
    let dir;
    let database;
    let gateway;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-entity-gateway-'));
        database = Database.open(dir);
        const users = new UserRepository(database);
        const userOptions = { resolveUserId: users.resolveId };
        gateway = new EntityGateway(database, {
            rooms: new RoomRepository(database, userOptions),
            players: new PlayerRepository(database, userOptions),
            roundScores: new RoundScoreRepository(database),
            chatMessages: new ChatMessageRepository(database),
            records: new RecordRepository(database),
        });
    });

    afterEach(() => {
        database.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function countRows(table) {
        return database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
    }

    test('insertMany returns the new records in order, for a table and for records', () => {
        const [room] = gateway.insertMany('GameRoom', [{ code: 'ABCD', status: 'waiting' }], CREATOR);
        const players = gateway.insertMany(
            'Player',
            [
                { room_id: room.id, name: 'Ann', email: 'ann@example.com' },
                { room_id: room.id, name: 'Bob', email: 'bob@example.com' },
            ],
            CREATOR,
        );
        const notes = gateway.insertMany('Note', [{ text: 'one' }, { text: 'two' }], CREATOR);

        assert.deepEqual(players.map((player) => player.name), ['Ann', 'Bob']);
        assert.deepEqual(gateway.find('Player', 'room_id', room.id), players);
        assert.deepEqual(notes.map((note) => note.text), ['one', 'two']);
        assert.deepEqual(gateway.list('Note').map((entry) => entry.record), notes);
    });

    test('insertMany into a table stores nothing when one item fails, users created for it included', () => {
        const [room] = gateway.insertMany('GameRoom', [{ code: 'ABCD', status: 'waiting' }], CREATOR);
        const usersBefore = countRows('users');

        assert.throws(
            () => gateway.insertMany(
                'Player',
                [
                    { room_id: room.id, name: 'Ann', email: 'ann@example.com' },
                    { room_id: room.id, name: 'No email' },
                ],
                CREATOR,
            ),
            (error) => error instanceof StoreError && error.message === 'email is required',
        );

        assert.equal(countRows('players'), 0);
        assert.equal(countRows('users'), usersBefore);
    });

    test('insertMany into records stores nothing when one item fails', () => {
        // JSON.stringify throws on a BigInt, after the first item is already written.
        assert.throws(
            () => gateway.insertMany('Note', [{ text: 'one' }, { text: 'two', size: 1n }], CREATOR),
            TypeError,
        );

        assert.equal(countRows('records'), 0);
    });

    test('findByEmail matches a Player by its user email and a record by its email field', () => {
        const [room] = gateway.insertMany('GameRoom', [{ code: 'ABCD', status: 'waiting' }], CREATOR);
        const [player] = gateway.insertMany('Player', [{ room_id: room.id, email: ' Ann@Example.com ' }], CREATOR);
        const [note] = gateway.insertMany('Note', [{ email: 'ANN@example.com' }], CREATOR);

        assert.deepEqual(gateway.findByEmail('Player', 'ann@example.com'), [player]);
        assert.deepEqual(gateway.findByEmail('Note', 'ann@example.com'), [note]);
    });

    test('update and delete give null for an id that does not exist', () => {
        assert.equal(gateway.update('GameRoom', 'missing', { status: 'playing' }), null);
        assert.equal(gateway.update('Note', 'missing', { text: 'x' }), null);
        assert.equal(gateway.delete('ChatMessage', 'missing'), null);
        assert.equal(gateway.delete('Note', 'missing'), null);
    });
});
