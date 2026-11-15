import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Database } from '../../src/database/Database.js';
import { EventRepository } from '../../src/repositories/EventRepository.js';

// EventRepository: the realtime event log in `events` and `meta`. realtime.test.js covers replay
// through the hub; these tests cover the log on its own.

/** An entry whose text is a small JSON message that carries its seq. */
function entry(roomId, entity = 'Player') {
    return { roomId, entity, buildText: (seq) => JSON.stringify({ seq, roomId }) };
}

function storedSeqs(database) {
    return database.prepare('SELECT seq FROM events ORDER BY seq').all().map((row) => row.seq);
}

describe('EventRepository', () => {
    let dir;
    let database;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-event-repository-'));
        database = Database.open(dir);
    });

    afterEach(() => {
        database.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    // --- Construction and epoch ---------------------------------------------

    test('a maxEvents below 1 or not an integer is rejected', () => {
        assert.throws(() => new EventRepository(database, { maxEvents: 0 }), /maxEvents must be an integer >= 1, got 0/);
        assert.throws(() => new EventRepository(database, { maxEvents: 1.5 }), /maxEvents must be an integer >= 1/);
        assert.throws(() => new EventRepository(database, { maxEvents: '5' }), /maxEvents must be an integer >= 1/);
    });

    test('a new log has an epoch, lastSeq 0 and no oldest seq', () => {
        const events = new EventRepository(database);

        assert.match(events.epoch, /^[0-9a-f]{16}$/);
        assert.equal(events.lastSeq, 0);
        assert.equal(events.oldestSeq(), null);
        assert.deepEqual(events.readAfter(0, null), []);
    });

    test('the epoch and lastSeq survive reopening the database', () => {
        const first = new EventRepository(database);
        first.appendAll([entry('r1'), entry('r1')]);
        database.close();

        database = Database.open(dir);
        const reopened = new EventRepository(database);

        assert.equal(reopened.epoch, first.epoch);
        assert.equal(reopened.lastSeq, 2);
        assert.equal(reopened.append(entry('r1')).seq, 3);
    });

    // --- Appending ----------------------------------------------------------

    test('appendAll numbers the entries in order and returns their seq and text', () => {
        const events = new EventRepository(database);

        const stored = events.appendAll([entry('r1', 'GameRoom'), entry(null, 'Note')]);

        assert.deepEqual(stored, [
            { seq: 1, text: '{"seq":1,"roomId":"r1"}' },
            { seq: 2, text: '{"seq":2,"roomId":null}' },
        ]);
        assert.equal(events.lastSeq, 2);
        assert.deepEqual(events.readAfter(0, null), [
            { seq: 1, room_id: 'r1', entity: 'GameRoom', text: '{"seq":1,"roomId":"r1"}' },
            { seq: 2, room_id: null, entity: 'Note', text: '{"seq":2,"roomId":null}' },
        ]);
    });

    test('appendAll with no entries stores nothing', () => {
        const events = new EventRepository(database);

        assert.deepEqual(events.appendAll([]), []);
        assert.equal(events.lastSeq, 0);
    });

    test('append stores one event and returns its seq and text', () => {
        const events = new EventRepository(database);
        events.append(entry('r1'));

        assert.deepEqual(events.append(entry('r2')), { seq: 2, text: '{"seq":2,"roomId":"r2"}' });
        assert.equal(events.lastSeq, 2);
    });

    test('a throw while appending stores nothing and keeps lastSeq', () => {
        const events = new EventRepository(database);
        events.append(entry('r1'));
        const failing = { roomId: 'r1', entity: 'Player', buildText: () => null };

        // The second row breaks events.text NOT NULL after the first was inserted.
        assert.throws(() => events.appendAll([entry('r1'), failing]), /NOT NULL/);

        assert.equal(events.lastSeq, 1);
        assert.deepEqual(storedSeqs(database), [1]);
        assert.equal(events.append(entry('r1')).seq, 2);
    });

    test('appending inside an outer transaction rolls back with it', () => {
        const events = new EventRepository(database);

        assert.throws(() => {
            database.transaction(() => {
                events.append(entry('r1'));
                throw new Error('outer failure');
            });
        }, /outer failure/);

        assert.deepEqual(storedSeqs(database), []);
    });

    // --- Trimming -----------------------------------------------------------

    test('appending keeps only the newest maxEvents events', () => {
        const events = new EventRepository(database, { maxEvents: 3 });

        events.appendAll([entry('r1'), entry('r1')]);
        events.appendAll([entry('r1'), entry('r1'), entry('r1')]);

        assert.deepEqual(storedSeqs(database), [3, 4, 5]);
        assert.equal(events.oldestSeq(), 3);
        assert.equal(events.lastSeq, 5);
    });

    test('trim with a seq counts back from that seq', () => {
        const events = new EventRepository(database, { maxEvents: 10 });
        events.appendAll([entry('r1'), entry('r1'), entry('r1'), entry('r1')]);

        new EventRepository(database, { maxEvents: 1 }).trim(3);

        assert.deepEqual(storedSeqs(database), [3, 4]);
    });

    // --- Reading ------------------------------------------------------------

    test('readAfter returns later events, filtered to the given rooms', () => {
        const events = new EventRepository(database);
        events.appendAll([entry('r1'), entry('r2'), entry(null, 'Note'), entry('r1'), entry('r3')]);

        const seqsOf = (rows) => rows.map((row) => row.seq);
        assert.deepEqual(seqsOf(events.readAfter(0, null)), [1, 2, 3, 4, 5]);
        assert.deepEqual(seqsOf(events.readAfter(2, null)), [3, 4, 5]);
        assert.deepEqual(seqsOf(events.readAfter(0, ['r1', 'r3'])), [1, 4, 5]);
        assert.deepEqual(seqsOf(events.readAfter(1, ['r1'])), [4]);
        assert.deepEqual(events.readAfter(0, []), []);
        assert.deepEqual(events.readAfter(5, null), []);
    });
});
