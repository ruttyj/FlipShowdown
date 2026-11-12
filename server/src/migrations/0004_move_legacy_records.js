import crypto from 'node:crypto';

// Moves the game records a database kept as JSON rows in `records` (GameRoom, Player, RoundScore,
// ChatMessage) into the typed tables 0003 created, so the store finds them again.
// - Rows move in records.seq order, rooms first, so each table keeps the old insertion order and
//   every parent exists before its children.
// - A player's (or room host's) email becomes a reference to its user; an email nobody has signed
//   in with gets a bare user, as a store write would give it.
// - Rows the new constraints can't hold go to `legacy_orphans` with a reason, never dropped: a
//   player, score or chat message whose room (or player) is gone, a player with no usable email,
//   and the later of two players one user had in the same room (possible once 0002 merged
//   case-variant users).
// - Of several open rooms sharing a code, all but the newest are closed. Looking a code up already
//   picked the newest, so the older ones were unreachable.
// - A value of the wrong type for its column (a string max_score, say) stays in `extra`, verbatim.
// Afterwards `records` keeps only the other entities' rows (those added through ENTITIES).
// Frozen: never edit a migration that has shipped, and never import from src/.

// --- Frozen copy of the table specs (src/entityTables.js at this version) ---------

const GAME_ROOM = {
    entity: 'GameRoom',
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
    userRef: { field: 'host_email', column: 'host_user_id' },
};

const PLAYER = {
    entity: 'Player',
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
    userRef: { field: 'email', column: 'user_id' },
};

const ROUND_SCORE = {
    entity: 'RoundScore',
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
    entity: 'ChatMessage',
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

const ORPHANS_SCHEMA = `
    CREATE TABLE legacy_orphans (
        seq          INTEGER PRIMARY KEY,  -- the row's records.seq
        entity       TEXT NOT NULL,
        id           TEXT NOT NULL,
        data         TEXT NOT NULL,
        created_date TEXT NOT NULL,
        updated_date TEXT NOT NULL,
        created_by   TEXT,
        reason       TEXT NOT NULL,        -- missing_room | missing_player | no_user | duplicate_member
        moved_date   TEXT NOT NULL
    )
`;

// --- Encoding a legacy record --------------------------------------------------

// The `typeof` a value must have for each column kind except 'json', which takes anything.
const JS_TYPE_BY_KIND = { text: 'string', number: 'number', boolean: 'boolean' };

/** Whether a column of this kind can hold the value; null fits any column. */
function fitsColumn(kind, value) {
    if (value === null || kind === 'json') {
        return true;
    }
    return typeof value === JS_TYPE_BY_KIND[kind];
}

function storageValue(kind, value) {
    if (value === null) {
        return null;
    }
    if (kind === 'boolean') {
        return value ? 1 : 0;
    }
    if (kind === 'json') {
        return JSON.stringify(value);
    }
    return value;
}

/**
 * The email in a legacy value, or null when it holds none. 0002 already made every email string
 * in these records canonical (blank ones became ''), so there is nothing left to normalise.
 */
function usableEmail(value) {
    const isUsable = typeof value === 'string' && value !== '';
    if (!isUsable) {
        return null;
    }
    return value;
}

/**
 * Splits a legacy record's data into `{ columns, extra, userEmail }`: storage values for the
 * declared columns (null when unset), everything else for `extra`, and the canonical email of the
 * user it refers to (null for none). Unlike a store write this never refuses a value: one that
 * doesn't fit its column, or an unusable email, is kept in `extra` as it was. The internal user id
 * column is never taken from data.
 */
function encodeLegacyData(spec, data) {
    const columns = {};
    for (const field of Object.keys(spec.columns)) {
        columns[field] = null;
    }
    // No prototype, so a "__proto__" field is stored as plain data like any other.
    const extra = Object.create(null);
    let userEmail = null;

    for (const [field, value] of Object.entries(data)) {
        const isUserReference = spec.userRef !== null && field === spec.userRef.field;
        const isUserIdColumn = spec.userRef !== null && field === spec.userRef.column;
        const isDeclared = Object.hasOwn(spec.columns, field);

        if (isUserIdColumn) {
            continue;
        }
        if (isUserReference) {
            userEmail = usableEmail(value);
            if (userEmail === null && value !== null) {
                extra[field] = value;
            }
        } else if (isDeclared && fitsColumn(spec.columns[field], value)) {
            columns[field] = storageValue(spec.columns[field], value);
        } else {
            extra[field] = value;
        }
    }
    return { columns, extra, userEmail };
}

// --- Statements ------------------------------------------------------------------

function prepareInsert(db, spec) {
    const columns = ['id', ...Object.keys(spec.columns)];
    if (spec.userRef) {
        columns.push(spec.userRef.column);
    }
    columns.push('extra', 'created_date', 'updated_date', 'created_by');

    const names = columns.join(', ');
    const values = columns.map((column) => `@${column}`).join(', ');
    return db.prepare(`INSERT INTO ${spec.table} (${names}) VALUES (${values})`);
}

/** Entity name -> its table's INSERT statement. */
function prepareInserts(db) {
    const inserts = new Map();
    for (const spec of [GAME_ROOM, PLAYER, ROUND_SCORE, CHAT_MESSAGE]) {
        inserts.set(spec.entity, prepareInsert(db, spec));
    }
    return inserts;
}

/** Everything the move needs: prepared statements and the time stamped on what it creates. */
function createContext(db) {
    return {
        movedDate: new Date().toISOString(),
        legacyRows: db.prepare('SELECT * FROM records WHERE entity = ? ORDER BY seq'),
        findUser: db.prepare('SELECT id FROM users WHERE email = ?'),
        insertUser: db.prepare(
            'INSERT INTO users (id, email, full_name, created_date, updated_date) VALUES (?, ?, NULL, ?, ?)',
        ),
        roomExists: db.prepare('SELECT 1 FROM game_rooms WHERE id = ?'),
        playerExists: db.prepare('SELECT 1 FROM players WHERE id = ?'),
        memberExists: db.prepare('SELECT 1 FROM players WHERE room_id = ? AND user_id = ?'),
        closeOpenRoomsWithCode: db.prepare("UPDATE game_rooms SET status = 'closed' WHERE code = ? AND status IS NOT 'closed'"),
        insertOrphan: db.prepare(
            'INSERT INTO legacy_orphans (seq, entity, id, data, created_date, updated_date, created_by, reason, moved_date) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ),
        inserts: prepareInserts(db),
    };
}

// --- Moving rows -----------------------------------------------------------------

/** The id of the user with this canonical email, creating one with no name if there is none. */
function userIdFor(context, email) {
    const existing = context.findUser.get(email);
    if (existing) {
        return existing.id;
    }

    const id = crypto.randomBytes(12).toString('hex');
    context.insertUser.run(id, email, context.movedDate, context.movedDate);
    return id;
}

function exists(statement, ...values) {
    return statement.get(...values) !== undefined;
}

/** Inserts the row into its table, keeping its id, dates and creator. */
function insertMoved(context, spec, row, columns, extra) {
    context.inserts.get(spec.entity).run({
        ...columns,
        id: row.id,
        extra: JSON.stringify(extra),
        created_date: row.created_date,
        updated_date: row.updated_date,
        created_by: row.created_by,
    });
}

function insertOrphan(context, row, reason) {
    context.insertOrphan.run(
        row.seq,
        row.entity,
        row.id,
        row.data,
        row.created_date,
        row.updated_date,
        row.created_by,
        reason,
        context.movedDate,
    );
}

/**
 * Closing an older room with the same code isn't an edit anyone made, so its updated_date stays.
 * A room whose code or status didn't fit its column has a NULL code or counts as open, and NULL
 * codes never collide.
 */
function moveRoom(context, row) {
    const { columns, extra, userEmail } = encodeLegacyData(GAME_ROOM, JSON.parse(row.data));
    columns.host_user_id = null;
    if (userEmail !== null) {
        columns.host_user_id = userIdFor(context, userEmail);
    }

    const isOpenWithCode = columns.code !== null && columns.status !== 'closed';
    if (isOpenWithCode) {
        // Rows arrive oldest first, so the room being moved is newer than any already open.
        context.closeOpenRoomsWithCode.run(columns.code);
    }
    insertMoved(context, GAME_ROOM, row, columns, extra);
}

function movePlayer(context, row) {
    const { columns, extra, userEmail } = encodeLegacyData(PLAYER, JSON.parse(row.data));
    if (!exists(context.roomExists, columns.room_id)) {
        insertOrphan(context, row, 'missing_room');
        return;
    }
    if (userEmail === null) {
        insertOrphan(context, row, 'no_user');
        return;
    }

    columns.user_id = userIdFor(context, userEmail);
    if (exists(context.memberExists, columns.room_id, columns.user_id)) {
        insertOrphan(context, row, 'duplicate_member');
        return;
    }
    insertMoved(context, PLAYER, row, columns, extra);
}

function moveRoundScore(context, row) {
    const { columns, extra } = encodeLegacyData(ROUND_SCORE, JSON.parse(row.data));
    if (!exists(context.roomExists, columns.room_id)) {
        insertOrphan(context, row, 'missing_room');
        return;
    }
    if (!exists(context.playerExists, columns.player_id)) {
        insertOrphan(context, row, 'missing_player');
        return;
    }
    insertMoved(context, ROUND_SCORE, row, columns, extra);
}

function moveChatMessage(context, row) {
    const { columns, extra } = encodeLegacyData(CHAT_MESSAGE, JSON.parse(row.data));
    if (!exists(context.roomExists, columns.room_id)) {
        insertOrphan(context, row, 'missing_room');
        return;
    }
    insertMoved(context, CHAT_MESSAGE, row, columns, extra);
}

// Parents before children, so every reference a row makes is checked against moved rows.
const MOVES = [
    { entity: 'GameRoom', move: moveRoom },
    { entity: 'Player', move: movePlayer },
    { entity: 'RoundScore', move: moveRoundScore },
    { entity: 'ChatMessage', move: moveChatMessage },
];

export function up(db) {
    db.exec(ORPHANS_SCHEMA);
    const context = createContext(db);

    for (const { entity, move } of MOVES) {
        for (const row of context.legacyRows.all(entity)) {
            move(context, row);
        }
    }

    // Every moved row now lives in its table and every orphan in legacy_orphans; the pre-migration
    // snapshot keeps the originals. Only the other entities still use records, and the app never
    // looks those up by email or code, so these two indexes would only slow down every write.
    db.exec(`
        DELETE FROM records WHERE entity IN ('GameRoom', 'Player', 'RoundScore', 'ChatMessage');
        DROP INDEX IF EXISTS records_email;
        DROP INDEX IF EXISTS records_code;
    `);
}
