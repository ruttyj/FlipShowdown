// Gives the four game entities real tables, so the database can enforce what the game code
// assumes: typed columns, players and room hosts pointing at users by id, children deleted with
// their room or player, one player per user per room, and one open room per join code.
// - Declared fields are columns; anything else a record carries goes into `extra` (a JSON object).
// - `seq` keeps insertion order, which list order and sort tie-breaks rely on.
// - The room's player pointers (host_player_id, current_turn_player_id, edit_mode_by,
//   winner_player_id) and chat's sender/recipient are plain text, not foreign keys: the game code
//   keeps them up to date, and chat outlives the players who sent it.
// This creates empty tables; the game rows still in `records` move over in a later migration.
// Frozen: never edit a migration that has shipped.

// The server-managed fields and `extra`, shared by every table.
const COMMON_COLUMNS = `
    extra        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra) AND json_type(extra) = 'object'),
    created_date TEXT NOT NULL,
    updated_date TEXT NOT NULL,
    created_by   TEXT
`;

const SCHEMA = `
    CREATE TABLE game_rooms (
        seq                    INTEGER PRIMARY KEY AUTOINCREMENT,
        id                     TEXT NOT NULL UNIQUE,
        code                   TEXT,
        status                 TEXT,
        game_mode              TEXT,
        host_user_id           TEXT REFERENCES users (id),
        host_player_id         TEXT,
        current_turn_player_id TEXT,
        edit_mode_by           TEXT,
        winner_player_id       TEXT,
        finish_reason          TEXT,
        last_activity_date     TEXT,
        max_score              INTEGER,
        current_round          INTEGER,
        game_number            INTEGER,
        version                INTEGER,
        turn_passed_round      INTEGER,
        is_edit_mode           INTEGER CHECK (is_edit_mode IN (0, 1)),
        ${COMMON_COLUMNS}
    );
    CREATE INDEX game_rooms_code ON game_rooms (code);
    -- IS NOT, so a room with no status counts as open. NULL codes never collide.
    CREATE UNIQUE INDEX game_rooms_open_code ON game_rooms (code) WHERE status IS NOT 'closed';

    CREATE TABLE players (
        seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
        id                  TEXT NOT NULL UNIQUE,
        room_id             TEXT NOT NULL REFERENCES game_rooms (id) ON DELETE CASCADE,
        user_id             TEXT NOT NULL REFERENCES users (id),
        name                TEXT,
        last_seen           TEXT,
        turn_order          INTEGER,
        total_score         INTEGER,
        current_round_score INTEGER,
        games_won           INTEGER,
        is_host             INTEGER CHECK (is_host IN (0, 1)),
        has_submitted_round INTEGER CHECK (has_submitted_round IN (0, 1)),
        ${COMMON_COLUMNS}
    );
    -- Also serves the finds by room_id (its leading column).
    CREATE UNIQUE INDEX players_room_user ON players (room_id, user_id);
    CREATE INDEX players_user ON players (user_id);

    CREATE TABLE round_scores (
        seq                    INTEGER PRIMARY KEY AUTOINCREMENT,
        id                     TEXT NOT NULL UNIQUE,
        room_id                TEXT NOT NULL REFERENCES game_rooms (id) ON DELETE CASCADE,
        player_id              TEXT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
        round_number           INTEGER,
        base_sum               INTEGER,
        final_score            INTEGER,
        cards                  TEXT CHECK (cards IS NULL OR json_valid(cards)),
        busted                 INTEGER CHECK (busted IN (0, 1)),
        duplicate_allowed      INTEGER CHECK (duplicate_allowed IN (0, 1)),
        flip7_attack_player_id TEXT,
        ${COMMON_COLUMNS}
    );
    CREATE INDEX round_scores_room ON round_scores (room_id);
    CREATE INDEX round_scores_player ON round_scores (player_id);

    CREATE TABLE chat_messages (
        seq          INTEGER PRIMARY KEY AUTOINCREMENT,
        id           TEXT NOT NULL UNIQUE,
        room_id      TEXT NOT NULL REFERENCES game_rooms (id) ON DELETE CASCADE,
        sender_id    TEXT,
        recipient_id TEXT,
        emoji        TEXT,
        message      TEXT,
        ${COMMON_COLUMNS}
    );
    CREATE INDEX chat_messages_room ON chat_messages (room_id);
`;

export function up(db) {
    db.exec(SCHEMA);
}
