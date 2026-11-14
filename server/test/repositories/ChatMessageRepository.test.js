import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Database } from '../../src/database/Database.js';
import { StoreError } from '../../src/database/entityTables.js';
import { ChatMessageRepository } from '../../src/repositories/ChatMessageRepository.js';

// ChatMessageRepository: the chat_messages table. The shared CRUD is covered in depth by
// tableRepository.test.js; these tests check it is wired to the right table and cover listByRoom.

/** Inserts a bare game room straight into its table and returns its id. */
function insertRoom(database, id) {
    database
        .prepare("INSERT INTO game_rooms (id, extra, created_date, updated_date) VALUES (?, '{}', '', '')")
        .run(id);
    return id;
}

describe('ChatMessageRepository', () => {
    let dir;
    let database;
    let messages;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-chat-repository-'));
        database = Database.open(dir);
        messages = new ChatMessageRepository(database);
        insertRoom(database, 'room-a');
        insertRoom(database, 'room-b');
    });

    afterEach(() => {
        database.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('insert stores a message in chat_messages and returns it as get gives it', () => {
        const created = messages.insert(
            { room_id: 'room-a', sender_id: 'p1', emoji: '🔥', mood: 'happy' },
            'sender@example.com',
        );

        assert.equal(created.room_id, 'room-a');
        assert.equal(created.sender_id, 'p1');
        assert.equal(created.recipient_id, null);
        assert.equal(created.emoji, '🔥');
        assert.equal(created.message, null);
        assert.equal(created.mood, 'happy');
        assert.equal(created.created_by, 'sender@example.com');
        assert.deepEqual(messages.get(created.id), created);

        const row = database.prepare('SELECT room_id, extra FROM chat_messages WHERE id = ?').get(created.id);
        assert.deepEqual({ ...row }, { room_id: 'room-a', extra: '{"mood":"happy"}' });
    });

    test('insert refuses a message for a room that does not exist', () => {
        assert.throws(
            () => messages.insert({ room_id: 'no-such-room', message: 'hi' }),
            (error) => error instanceof StoreError && error.status === 400,
        );
    });

    test('listByRoom returns only that room\'s messages, oldest first', () => {
        const first = messages.insert({ room_id: 'room-a', message: 'one' });
        messages.insert({ room_id: 'room-b', message: 'elsewhere' });
        const second = messages.insert({ room_id: 'room-a', message: 'two' });

        const listed = messages.listByRoom('room-a');

        assert.deepEqual(listed.map((message) => message.id), [first.id, second.id]);
        assert.deepEqual(messages.listByRoom('room-c'), []);
    });

    test('list, find, update and delete work on chat messages', () => {
        const created = messages.insert({ room_id: 'room-a', recipient_id: 'p2', message: 'hi' });

        assert.deepEqual(messages.list().map((entry) => entry.record.id), [created.id]);
        assert.deepEqual(messages.find('recipient_id', 'p2').map((message) => message.id), [created.id]);

        const updated = messages.update(created.id, { message: 'hello' });
        assert.equal(updated.message, 'hello');

        assert.deepEqual(messages.delete(created.id), updated);
        assert.equal(messages.get(created.id), null);
    });
});
