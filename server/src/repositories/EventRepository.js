import crypto from 'node:crypto';

// The durable realtime event log, in the `events` and `meta` tables that migration 0001 creates.
// It lets clients replay missed events across server restarts. The log keeps only the newest
// `maxEvents` events, and an epoch that identifies this log: a client that sees a different epoch
// knows the log it was following is gone.

const DEFAULT_MAX_EVENTS = 5000;

function prepareStatements(database) {
    return {
        insertEpoch: database.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('epoch', ?)"),
        selectEpoch: database.prepare("SELECT value FROM meta WHERE key = 'epoch'"),
        maxSeq: database.prepare('SELECT MAX(seq) AS seq FROM events'),
        minSeq: database.prepare('SELECT MIN(seq) AS seq FROM events'),
        insertEvent: database.prepare('INSERT INTO events (seq, room_id, entity, text) VALUES (?, ?, ?, ?)'),
        deleteUpTo: database.prepare('DELETE FROM events WHERE seq <= ?'),
        readAll: database.prepare('SELECT seq, room_id, entity, text FROM events WHERE seq > ? ORDER BY seq'),
        // json_each turns the JSON array of room ids into rows for the IN check.
        readRooms: database.prepare(
            'SELECT seq, room_id, entity, text FROM events'
            + ' WHERE seq > ? AND room_id IN (SELECT value FROM json_each(?))'
            + ' ORDER BY seq',
        ),
    };
}

/**
 * The epoch is created the first time the database is used and never changes afterwards. A new
 * epoch therefore means the event log was lost.
 */
function ensureEpoch(statements) {
    statements.insertEpoch.run(crypto.randomBytes(8).toString('hex'));
    return statements.selectEpoch.get().value;
}

/** The rows for `entries` numbered on from `lastSeq`: [{ seq, roomId, entity, text }]. */
function numberEntries(entries, lastSeq) {
    const rows = [];
    for (const [index, entry] of entries.entries()) {
        const seq = lastSeq + 1 + index;
        rows.push({ seq, roomId: entry.roomId, entity: entry.entity, text: entry.buildText(seq) });
    }
    return rows;
}

export class EventRepository {
    /**
     * `database` is a Database. `maxEvents` is how many of the newest events are kept (tests lower
     * it); it must be at least 1, because the newest event is what keeps `seq` counting up across
     * restarts. Creates the log's epoch if the database has none yet.
     */
    constructor(database, { maxEvents = DEFAULT_MAX_EVENTS } = {}) {
        if (!Number.isInteger(maxEvents) || maxEvents < 1) {
            throw new Error(`maxEvents must be an integer >= 1, got ${maxEvents}`);
        }

        this.database = database;
        this.maxEvents = maxEvents;
        this.statements = prepareStatements(database);
        this.epochValue = ensureEpoch(this.statements);
        // The newest event is never trimmed, so MAX(seq) survives restarts.
        this.lastSeqValue = this.statements.maxSeq.get().seq ?? 0;
    }

    /** This log's id, the same for as long as the database keeps its `meta` table. */
    get epoch() {
        return this.epochValue;
    }

    /** The seq of the newest event appended, or 0 when nothing ever was. */
    get lastSeq() {
        return this.lastSeqValue;
    }

    /** Lowest seq still stored, or null when the log is empty. */
    oldestSeq() {
        return this.statements.minSeq.get().seq ?? null;
    }

    /** Stores one event; see appendAll. Returns its `{ seq, text }`. */
    append(entry) {
        const [stored] = this.appendAll([entry]);
        return stored;
    }

    /**
     * Stores the next events in one transaction, in order, then trims the log. Each entry is
     * `{ roomId, entity, buildText }`, where `buildText(seq)` returns the JSON text to store,
     * because the message itself contains its seq. Returns `[{ seq, text }]` in the same order. On
     * a throw nothing is stored and `lastSeq` is unchanged.
     */
    appendAll(entries) {
        if (entries.length === 0) {
            return [];
        }

        const rows = numberEntries(entries, this.lastSeqValue);
        const newestSeq = rows[rows.length - 1].seq;
        this.database.transaction(() => {
            for (const row of rows) {
                this.statements.insertEvent.run(row.seq, row.roomId, row.entity, row.text);
            }
            this.trim(newestSeq);
        });

        this.lastSeqValue = newestSeq;
        return rows.map((row) => ({ seq: row.seq, text: row.text }));
    }

    /**
     * Deletes every event older than the newest `maxEvents`, counting back from `newestSeq`
     * (by default the newest appended). appendAll calls it, so the log never grows past its limit.
     */
    trim(newestSeq = this.lastSeqValue) {
        this.statements.deleteUpTo.run(newestSeq - this.maxEvents);
    }

    /**
     * Events with seq > afterSeq, oldest first, as `{ seq, room_id, entity, text }`. `roomIds` is
     * an array of room ids, or null for every event (rooms or not).
     */
    readAfter(afterSeq, roomIds) {
        if (roomIds === null) {
            return this.statements.readAll.all(afterSeq);
        }
        return this.statements.readRooms.all(afterSeq, JSON.stringify(roomIds));
    }
}
