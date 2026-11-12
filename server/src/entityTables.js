import { normaliseEmail } from './email.js';

// How the four game entities map onto their tables (migration 0003), and the conversion between
// an API record and a table row. db.js runs the SQL; this module is pure.
//
// A record keeps the shape it had when it was stored as JSON:
// - every declared field is present, as null when it was never set;
// - fields the table has no column for live in the row's `extra` JSON object;
// - a Player's `email` and a GameRoom's `host_email` come from the user the row points at (the
//   "user reference"), so they are always canonical.

// --- Errors ------------------------------------------------------------------

/**
 * A write the database refused, or a value of the wrong type. `status` is 400 (`invalid_record`)
 * or 409 (`conflict`); the routes answer with `toBody()`.
 */
export class StoreError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }

    toBody() {
        return { message: this.message, code: this.code };
    }
}

function invalidRecord(message) {
    return new StoreError(400, 'invalid_record', message);
}

// --- Tables ------------------------------------------------------------------

// Column kinds: 'text' (string), 'number', 'boolean' (stored as 0/1) and 'json' (any JSON value,
// stored as text). The column names are the record's field names.
const GAME_ROOM = {
    table: 'game_rooms',
    columns: {
        code: 'text',
        status: 'text',
        game_mode: 'text',
        host_player_id: 'text',
        current_turn_player_id: 'text',
        edit_mode_by: 'text',
        winner_player_id: 'text',
        finish_reason: 'text',
        last_activity_date: 'text',
        max_score: 'number',
        current_round: 'number',
        game_number: 'number',
        version: 'number',
        turn_passed_round: 'number',
        is_edit_mode: 'boolean',
    },
    // A room may have no host user (null host_email).
    userRef: { field: 'host_email', column: 'host_user_id' },
};

const PLAYER = {
    table: 'players',
    columns: {
        room_id: 'text',
        name: 'text',
        last_seen: 'text',
        turn_order: 'number',
        total_score: 'number',
        current_round_score: 'number',
        games_won: 'number',
        is_host: 'boolean',
        has_submitted_round: 'boolean',
    },
    // Required: players.user_id is NOT NULL.
    userRef: { field: 'email', column: 'user_id' },
};

const ROUND_SCORE = {
    table: 'round_scores',
    columns: {
        room_id: 'text',
        player_id: 'text',
        round_number: 'number',
        base_sum: 'number',
        final_score: 'number',
        cards: 'json',
        busted: 'boolean',
        duplicate_allowed: 'boolean',
        flip7_attack_player_id: 'text',
    },
    userRef: null,
};

const CHAT_MESSAGE = {
    table: 'chat_messages',
    columns: {
        room_id: 'text',
        sender_id: 'text',
        recipient_id: 'text',
        emoji: 'text',
        message: 'text',
    },
    userRef: null,
};

/** Entity name -> table spec. Any other entity is stored in the generic `records` table. */
export const ENTITY_TABLES = new Map([
    ['GameRoom', GAME_ROOM],
    ['Player', PLAYER],
    ['RoundScore', ROUND_SCORE],
    ['ChatMessage', CHAT_MESSAGE],
]);

// --- Writing -----------------------------------------------------------------

// The `typeof` a value must have for each column kind except 'json', which takes anything.
const JS_TYPE_BY_KIND = { text: 'string', number: 'number', boolean: 'boolean' };

/** One field's value in storage form. Throws a 400 StoreError for a value of the wrong type. */
function encodeValue(field, kind, value) {
    if (value === undefined || value === null) {
        return null;
    }

    if (kind === 'json') {
        return JSON.stringify(value);
    }
    const expectedType = JS_TYPE_BY_KIND[kind];
    if (typeof value !== expectedType) {
        throw invalidRecord(`${field} must be a ${expectedType}`);
    }
    if (kind === 'boolean') {
        return value ? 1 : 0;
    }
    if (kind === 'number' && !Number.isFinite(value)) {
        // JSON storage turned NaN and Infinity into null; keep doing that.
        return null;
    }
    return value;
}

/**
 * The canonical email for a user reference field: null to point at no user, or a string. Throws a
 * 400 StoreError for anything that isn't an email address.
 */
function encodeUserEmail(field, value) {
    if (value === undefined || value === null) {
        return null;
    }

    const email = normaliseEmail(value);
    if (email === null) {
        throw invalidRecord(`${field} must be an email address`);
    }
    return email;
}

/** A row with nothing set, for a new record. */
export function emptyRow(spec) {
    const columns = {};
    for (const field of Object.keys(spec.columns)) {
        columns[field] = null;
    }
    if (spec.userRef) {
        columns[spec.userRef.column] = null;
    }
    return { columns, extra: {} };
}

/** A stored row (as SELECT returns it) in the form applyFields takes. */
export function storedRow(spec, row) {
    const { columns } = emptyRow(spec);
    for (const column of Object.keys(columns)) {
        columns[column] = row[column];
    }
    return { columns, extra: JSON.parse(row.extra) };
}

/**
 * Applies a write's fields (server-managed fields already removed) to `row`, a `{ columns, extra }`
 * in storage form, and returns a new one, plus `userEmail`: undefined when the user reference is
 * unchanged, otherwise the canonical email to point at (null for none). Only the fields named in
 * `fields` are checked, so a stored value is never re-validated. Undefined clears a field.
 * Throws a 400 StoreError for a value of the wrong type.
 */
export function applyFields(spec, row, fields) {
    const columns = { ...row.columns };
    // No prototype, so a "__proto__" field is stored as plain data like any other.
    const extra = Object.assign(Object.create(null), row.extra);
    let userEmail;

    for (const [field, value] of Object.entries(fields)) {
        const isUserReference = spec.userRef !== null && field === spec.userRef.field;
        const isUserIdColumn = spec.userRef !== null && field === spec.userRef.column;

        if (isUserIdColumn) {
            // The user id is internal; the email field is how a write chooses the user.
            continue;
        }
        if (isUserReference) {
            userEmail = encodeUserEmail(field, value);
        } else if (Object.hasOwn(spec.columns, field)) {
            columns[field] = encodeValue(field, spec.columns[field], value);
            // A value that once couldn't fit the column (a legacy row) is replaced, not kept twice.
            delete extra[field];
        } else if (value === undefined) {
            delete extra[field];
        } else {
            extra[field] = value;
        }
    }
    return { columns, extra, userEmail };
}

// --- Reading -----------------------------------------------------------------

function decodeValue(kind, value) {
    if (value === null) {
        return null;
    }
    if (kind === 'boolean') {
        return value === 1;
    }
    if (kind === 'json') {
        return JSON.parse(value);
    }
    return value;
}

/**
 * The API record for a row SELECTed with its user's email as `user_email`: declared fields, then
 * `extra`, then the user reference and the server-managed fields (which win over anything stored
 * under the same name).
 */
export function decodeRow(spec, row) {
    const columns = {};
    for (const [field, kind] of Object.entries(spec.columns)) {
        columns[field] = decodeValue(kind, row[field]);
    }

    // Spread defines own properties, so a "__proto__" key from extra stays plain data.
    const record = { ...columns, ...JSON.parse(row.extra) };
    if (spec.userRef) {
        record[spec.userRef.field] = row.user_email;
    }
    return {
        ...record,
        id: row.id,
        created_date: row.created_date,
        updated_date: row.updated_date,
        created_by: row.created_by,
    };
}

// --- SQLite errors -----------------------------------------------------------

// The record field behind each user id column, for "is required" messages.
const USER_REFERENCE_FIELD_BY_COLUMN = new Map();
for (const spec of ENTITY_TABLES.values()) {
    if (spec.userRef) {
        USER_REFERENCE_FIELD_BY_COLUMN.set(spec.userRef.column, spec.userRef.field);
    }
}

/** Example: "UNIQUE constraint failed: players.room_id, players.user_id" -> a message for people. */
function conflictMessage(sqliteMessage) {
    if (sqliteMessage.includes('players.room_id, players.user_id')) {
        return 'That user already has a player in this room';
    }
    if (sqliteMessage.includes('game_rooms.code')) {
        return 'Another open room already uses this code';
    }
    return 'The record conflicts with an existing one';
}

/** Example: "NOT NULL constraint failed: players.user_id" -> "email is required". */
function missingFieldMessage(sqliteMessage) {
    const match = /NOT NULL constraint failed: \w+\.(\w+)/.exec(sqliteMessage);
    const column = match[1];
    const field = USER_REFERENCE_FIELD_BY_COLUMN.get(column) ?? column;
    return `${field} is required`;
}

/**
 * Turns a SQLite constraint violation into a StoreError: UNIQUE is a 409 `conflict`, the rest
 * (NOT NULL, FOREIGN KEY, CHECK) a 400 `invalid_record`. Anything else is returned unchanged.
 */
export function toStoreError(error) {
    const code = error.code;
    const isConstraintViolation = typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
    if (!isConstraintViolation) {
        return error;
    }

    if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return new StoreError(409, 'conflict', conflictMessage(error.message));
    }
    if (code === 'SQLITE_CONSTRAINT_NOTNULL') {
        return invalidRecord(missingFieldMessage(error.message));
    }
    if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        return invalidRecord('room_id or player_id does not refer to an existing record');
    }
    return invalidRecord(`Invalid record (${error.message})`);
}
