import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Database } from '../src/database/Database.js';
import { openStore } from '../src/database/db.js';
import { ChatMessageRepository } from '../src/repositories/ChatMessageRepository.js';
import { EventRepository } from '../src/repositories/EventRepository.js';
import { PlayerRepository } from '../src/repositories/PlayerRepository.js';
import { RecordRepository } from '../src/repositories/RecordRepository.js';
import { RoomRepository } from '../src/repositories/RoomRepository.js';
import { RoundScoreRepository } from '../src/repositories/RoundScoreRepository.js';
import { UserRepository } from '../src/repositories/UserRepository.js';

// openStore as a facade over Database and the repositories: what it exposes beyond the record
// API, and the store behaviour it keeps where a repository differs. The record API itself is
// covered by store.test.js and the HTTP tests.

describe('openStore facade', () => {
    let dir;
    let store;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-store-facade-'));
        store = openStore(dir, { eventLogLimit: 3 });
    });

    afterEach(() => {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('exposes the Database and one repository per table, read-only', () => {
        const { repositories } = store;

        assert.ok(store.database instanceof Database);
        assert.ok(repositories.users instanceof UserRepository);
        assert.ok(repositories.rooms instanceof RoomRepository);
        assert.ok(repositories.players instanceof PlayerRepository);
        assert.ok(repositories.roundScores instanceof RoundScoreRepository);
        assert.ok(repositories.chatMessages instanceof ChatMessageRepository);
        assert.ok(repositories.records instanceof RecordRepository);
        assert.ok(repositories.events instanceof EventRepository);

        assert.throws(() => {
            store.database = null;
        }, TypeError);
        assert.throws(() => {
            store.repositories = {};
        }, TypeError);
        assert.throws(() => {
            repositories.users = null;
        }, TypeError);
    });

    test('the repositories share the store\'s connection', () => {
        const [room] = store.createRecords('GameRoom', [{ code: 'ABCD', status: 'waiting' }], 'a@example.com');

        assert.deepEqual(store.repositories.rooms.get(room.id), room);
        assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM game_rooms').get().count, 1);
    });

    test('eventLog is the EventRepository, with eventLogLimit as its maxEvents', () => {
        const entries = [];
        for (let index = 0; index < 5; index++) {
            entries.push({ roomId: null, entity: 'GameRoom', buildText: (seq) => `{"seq":${seq}}` });
        }

        store.eventLog.appendAll(entries);

        assert.equal(store.eventLog, store.repositories.events);
        assert.equal(store.eventLog.lastSeq, 5);
        assert.equal(store.eventLog.oldestSeq(), 3);
    });

    test('setUserName returns the updated user, or undefined when there is no such user', () => {
        store.upsertUser('ann@example.com', 'Ann');

        assert.equal(store.setUserName('ANN@example.com', 'Annie').full_name, 'Annie');
        assert.equal(store.setUserName('nobody@example.com', 'Nobody'), undefined);
        assert.equal(store.findUserByEmail('nobody@example.com'), null);
    });
});
