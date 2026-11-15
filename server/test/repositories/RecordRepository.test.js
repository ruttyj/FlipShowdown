import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Database } from '../../src/database/Database.js';
import { StoreError } from '../../src/domain/errors.js';
import { RecordRepository } from '../../src/repositories/RecordRepository.js';

// RecordRepository: the generic `records` table, one JSON row per record, keyed by entity name.
// The same behaviour is covered through the store in store.test.js and the entities API tests.

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('RecordRepository', () => {
    let dir;
    let database;
    let records;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-record-repository-'));
        database = Database.open(dir);
        records = new RecordRepository(database);
    });

    afterEach(() => {
        database.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    // --- insert and get ------------------------------------------------------

    test('insert stores the item without server-managed fields and returns the new record', () => {
        const created = records.insert(
            'Note',
            { text: 'hello', id: 'chosen', created_date: 'x', updated_date: 'y', created_by: 'z' },
            'author@example.com',
        );

        assert.match(created.id, /^[0-9a-f]{24}$/);
        assert.match(created.created_date, ISO_TIMESTAMP);
        assert.equal(created.updated_date, created.created_date);
        assert.deepEqual(created, {
            text: 'hello',
            id: created.id,
            created_date: created.created_date,
            updated_date: created.created_date,
            created_by: 'author@example.com',
        });
        assert.deepEqual(records.get('Note', created.id), created);

        const row = database.prepare('SELECT entity, data FROM records WHERE id = ?').get(created.id);
        assert.deepEqual({ ...row }, { entity: 'Note', data: '{"text":"hello"}' });
    });

    test('insert keeps a "__proto__" field as plain data', () => {
        const item = JSON.parse('{"__proto__": {"polluted": true}, "text": "x"}');

        const created = records.insert('Note', item, null);

        assert.equal(Object.hasOwn(created, '__proto__'), true);
        assert.equal(created.polluted, undefined);
        assert.deepEqual(Object.keys(records.get('Note', created.id)).slice(0, 2), ['__proto__', 'text']);
    });

    test('insert with no creator stores created_by as null', () => {
        const created = records.insert('Note', { text: 'x' }, null);

        assert.equal(created.created_by, null);
        assert.equal(records.get('Note', created.id).created_by, null);
    });

    test('insert turns a constraint violation into a 400 StoreError', () => {
        // records.entity is NOT NULL, so a missing entity name is the reachable violation.
        assert.throws(
            () => records.insert(null, { text: 'x' }, null),
            (error) => error instanceof StoreError && error.status === 400 && error.code === 'invalid_record',
        );
    });

    test('insert passes other errors through unchanged', () => {
        assert.throws(() => records.insert('Note', { big: 1n }, null), TypeError);
    });

    test('get returns null for an unknown id or another entity\'s id', () => {
        const created = records.insert('Note', { text: 'x' }, null);

        assert.equal(records.get('Note', 'missing'), null);
        assert.equal(records.get('Other', created.id), null);
    });

    test('a stored server-managed field never overrides the real one', () => {
        database
            .prepare("INSERT INTO records (entity, id, data, created_date, updated_date, created_by) VALUES ('Note', 'n1', ?, 'c', 'u', 'b')")
            .run('{"id":"fake","created_by":"fake","text":"x"}');

        assert.deepEqual(records.get('Note', 'n1'), {
            id: 'n1',
            created_by: 'b',
            text: 'x',
            created_date: 'c',
            updated_date: 'u',
        });
    });

    // --- list and find -------------------------------------------------------

    test('list returns the entity\'s records oldest first, with their seq', () => {
        const first = records.insert('Note', { text: 'one' }, null);
        records.insert('Other', { text: 'other' }, null);
        const second = records.insert('Note', { text: 'two' }, null);

        const listed = records.list('Note');

        assert.deepEqual(listed.map((entry) => entry.record), [first, second]);
        assert.ok(listed[0].seq < listed[1].seq);
        assert.deepEqual(records.list('Empty'), []);
    });

    test('find by room_id returns matching records of that entity, oldest first', () => {
        const first = records.insert('Note', { room_id: 'r1', text: 'one' }, null);
        records.insert('Note', { room_id: 'r2' }, null);
        records.insert('Other', { room_id: 'r1' }, null);
        const second = records.insert('Note', { room_id: 'r1', text: 'two' }, null);

        assert.deepEqual(records.find('Note', 'room_id', 'r1'), [first, second]);
        assert.deepEqual(records.find('Note', 'room_id', 'r3'), []);
    });

    test('find by any other field matches its JSON value', () => {
        const red = records.insert('Note', { colour: 'red', count: 3 }, null);
        records.insert('Note', { colour: 'blue' }, null);

        assert.deepEqual(records.find('Note', 'colour', 'red'), [red]);
        assert.deepEqual(records.find('Note', 'count', 3), [red]);
        assert.deepEqual(records.find('Note', 'missing', 'red'), []);
    });

    test('findByEmail matches any spelling of the canonical email, oldest first', () => {
        const plain = records.insert('Note', { email: 'ann@example.com' }, null);
        const shouted = records.insert('Note', { email: '  ANN@Example.com ' }, null);
        records.insert('Note', { email: 'bob@example.com' }, null);
        records.insert('Note', { text: 'no email' }, null);
        records.insert('Other', { email: 'ann@example.com' }, null);

        assert.deepEqual(records.findByEmail('Note', 'ann@example.com'), [plain, shouted]);
        assert.deepEqual(records.findByEmail('Note', 'nobody@example.com'), []);
    });

    // --- update --------------------------------------------------------------

    test('update shallow-merges the changes without server-managed fields', () => {
        const created = records.insert('Note', { text: 'one', keep: true, nested: { a: 1 } }, 'author@example.com');

        const updated = records.update('Note', created.id, {
            text: 'two',
            nested: { b: 2 },
            dropped: undefined,
            id: 'hijack',
            created_by: 'hijack',
        });

        assert.deepEqual(updated, {
            text: 'two',
            keep: true,
            nested: { b: 2 },
            id: created.id,
            created_date: created.created_date,
            updated_date: updated.updated_date,
            created_by: 'author@example.com',
        });
        assert.match(updated.updated_date, ISO_TIMESTAMP);
        assert.deepEqual(records.get('Note', created.id), updated);
    });

    test('update returns null for an unknown record and writes nothing', () => {
        const created = records.insert('Note', { text: 'one' }, null);

        assert.equal(records.update('Note', 'missing', { text: 'two' }), null);
        assert.equal(records.update('Other', created.id, { text: 'two' }), null);
        assert.equal(records.get('Note', created.id).text, 'one');
    });

    test('update passes non-constraint errors through unchanged', () => {
        const created = records.insert('Note', { text: 'one' }, null);

        assert.throws(() => records.update('Note', created.id, { big: 1n }), TypeError);
    });

    // --- delete --------------------------------------------------------------

    test('delete removes the record and returns it as it was', () => {
        const created = records.insert('Note', { text: 'one' }, null);
        const other = records.insert('Other', { text: 'other' }, null);

        assert.deepEqual(records.delete('Note', created.id), created);
        assert.equal(records.get('Note', created.id), null);
        assert.deepEqual(records.get('Other', other.id), other);
    });

    test('delete returns null for an unknown record', () => {
        assert.equal(records.delete('Note', 'missing'), null);
    });
});
