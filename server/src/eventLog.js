import crypto from 'node:crypto';

// Durable realtime event log, stored in the `events` and `meta` tables that
// migration 0001 creates. It lets clients replay missed events across server restarts.

const DEFAULT_MAX_EVENTS = 5000;

function prepareStatements(db) {
    return {
        insertEpoch: db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('epoch', ?)"),
        selectEpoch: db.prepare("SELECT value FROM meta WHERE key = 'epoch'"),
        maxSeq: db.prepare('SELECT MAX(seq) AS seq FROM events'),
        minSeq: db.prepare('SELECT MIN(seq) AS seq FROM events'),
        insertEvent: db.prepare('INSERT INTO events (seq, room_id, entity, text) VALUES (?, ?, ?, ?)'),
        trimEvents: db.prepare('DELETE FROM events WHERE seq <= ?'),
        readAll: db.prepare('SELECT seq, room_id, entity, text FROM events WHERE seq > ? ORDER BY seq'),
        // json_each turns the JSON array of room ids into rows for the IN check.
        readRooms: db.prepare(
            'SELECT seq, room_id, entity, text FROM events'
            + ' WHERE seq > ? AND room_id IN (SELECT value FROM json_each(?))'
            + ' ORDER BY seq',
        ),
    };
}

/**
 * The epoch is created the first time the database is used and never changes
 * afterwards. A new epoch therefore means the event log was lost.
 */
function ensureEpoch(statements) {
    statements.insertEpoch.run(crypto.randomBytes(8).toString('hex'));
    return statements.selectEpoch.get().value;
}

/**
 * Wraps an open better-sqlite3 database. `maxEvents` is how many of the newest
 * events are kept (tests lower it); it must be at least 1, because the
 * newest event is what keeps `seq` counting up across restarts.
 */
export function createEventLog(db, { maxEvents = DEFAULT_MAX_EVENTS } = {}) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1) {
        throw new Error(`maxEvents must be an integer >= 1, got ${maxEvents}`);
    }

    const statements = prepareStatements(db);
    const epoch = ensureEpoch(statements);
    // The newest event is never trimmed, so MAX(seq) survives restarts.
    let lastSeq = statements.maxSeq.get().seq ?? 0;

    // rows: [{ seq, roomId, entity, text }], stored together or not at all.
    const insertAndTrim = db.transaction((rows) => {
        for (const row of rows) {
            statements.insertEvent.run(row.seq, row.roomId, row.entity, row.text);
        }
        statements.trimEvents.run(rows[rows.length - 1].seq - maxEvents);
    });

    return {
        get epoch() {
            return epoch;
        },

        get lastSeq() {
            return lastSeq;
        },

        /** Lowest seq still stored, or null when the log is empty. */
        oldestSeq() {
            return statements.minSeq.get().seq ?? null;
        },

        /**
         * Stores the next events in one transaction, in order. Each entry is
         * { roomId, entity, buildText }, where `buildText(seq)` returns the
         * JSON text to store, because the message itself contains its seq.
         * Returns [{ seq, text }] in the same order. On a throw nothing is
         * stored and `lastSeq` is unchanged.
         */
        appendAll(entries) {
            if (entries.length === 0) {
                return [];
            }

            const rows = [];
            for (const [index, entry] of entries.entries()) {
                const seq = lastSeq + 1 + index;
                rows.push({ seq, roomId: entry.roomId, entity: entry.entity, text: entry.buildText(seq) });
            }
            insertAndTrim(rows);

            lastSeq = rows[rows.length - 1].seq;
            return rows.map((row) => ({ seq: row.seq, text: row.text }));
        },

        /**
         * Events with seq > afterSeq, oldest first, as { seq, room_id, entity, text }.
         * `roomIds` is an array of room ids, or null for every event (rooms or not).
         */
        readAfter(afterSeq, roomIds) {
            if (roomIds === null) {
                return statements.readAll.all(afterSeq);
            }
            return statements.readRooms.all(afterSeq, JSON.stringify(roomIds));
        },
    };
}
