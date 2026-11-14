import { ChatMessageRepository } from '../repositories/ChatMessageRepository.js';
import { EntityGateway } from '../repositories/EntityGateway.js';
import { EventRepository } from '../repositories/EventRepository.js';
import { PlayerRepository } from '../repositories/PlayerRepository.js';
import { RecordRepository } from '../repositories/RecordRepository.js';
import { RoomRepository } from '../repositories/RoomRepository.js';
import { RoundScoreRepository } from '../repositories/RoundScoreRepository.js';
import { UserRepository } from '../repositories/UserRepository.js';
import { Database } from './Database.js';

// The store: the record-shaped API the routes and tests have always used, as a thin facade over
// Database and the repositories. Every method delegates; the SQL lives in the repositories.

/**
 * Opens the database (see Database.open) and returns its raw better-sqlite3 connection, with
 * foreign keys enforced. Kept for tests that read the migrated file directly; the server itself
 * goes through openStore.
 */
export function openDatabase(dataDir) {
    return Database.open(dataDir).connection;
}

/**
 * Builds one repository per table over `database`. `eventLogLimit` is the event log's maxEvents
 * (undefined for its default).
 */
function createRepositories(database, eventLogLimit) {
    const users = new UserRepository(database);
    const userOptions = { resolveUserId: users.resolveId };

    return {
        users,
        rooms: new RoomRepository(database, userOptions),
        players: new PlayerRepository(database, userOptions),
        roundScores: new RoundScoreRepository(database),
        chatMessages: new ChatMessageRepository(database),
        records: new RecordRepository(database),
        events: new EventRepository(database, { maxEvents: eventLogLimit }),
    };
}

/**
 * Opens the database (see Database.open) and returns a small store API.
 * All methods are synchronous, so each request's write is atomic.
 * GameRoom, Player, RoundScore and ChatMessage live in their own tables (see entityTables.js);
 * any other entity is a JSON row in `records`. Both give the same record shape.
 * Writes the database refuses throw a StoreError (400 or 409).
 * `eventLogLimit` overrides how many realtime events are kept (tests).
 *
 * `database` and `repositories` expose what the store is built on, for the code that replaces
 * the store in later steps.
 */
export function openStore(dataDir, { eventLogLimit } = {}) {
    const database = Database.open(dataDir);
    const repositories = Object.freeze(createRepositories(database, eventLogLimit));
    const users = repositories.users;
    const entities = new EntityGateway(database, repositories);

    return {
        get database() {
            return database;
        },

        get repositories() {
            return repositories;
        },

        // The realtime event log: epoch, lastSeq, oldestSeq, appendAll and readAfter.
        eventLog: repositories.events,

        listRecords(entity) {
            return entities.list(entity);
        },

        /**
         * Records whose top-level `field` equals `value` (a string), oldest
         * first. Example: findRecords('Player', 'room_id', roomId).
         */
        findRecords(entity, field, value) {
            return entities.find(entity, field, value);
        },

        /**
         * Records whose `email` matches `email` ignoring case and surrounding
         * spaces, oldest first. `email` must already be trimmed and lowercase.
         */
        findRecordsByEmail(entity, email) {
            return entities.findByEmail(entity, email);
        },

        getRecord(entity, id) {
            return entities.get(entity, id);
        },

        /** All or nothing: if one item fails, none is stored. */
        createRecords(entity, items, createdBy) {
            return entities.insertMany(entity, items, createdBy);
        },

        updateRecord(entity, id, changes) {
            return entities.update(entity, id, changes);
        },

        /** Deletes and returns the record as it was, or null if it didn't exist. */
        deleteRecord(entity, id) {
            return entities.delete(entity, id);
        },

        /**
         * Runs `fn` inside one SQLite transaction and returns its result. A
         * throw rolls everything back. better-sqlite3 transactions are
         * synchronous, so `fn` must not await. Store calls inside it (even
         * createRecords, which nests a savepoint) join the same transaction.
         */
        transaction(fn) {
            return database.transaction(fn);
        },

        // The user functions take an email in any spelling; users.email only holds the canonical one.

        findUserByEmail(email) {
            return users.findByEmail(email);
        },

        /**
         * Inserts the user on first sight. An existing user keeps their stored
         * name unless a non-empty `fullName` is given (e.g. from the dev login form).
         */
        upsertUser(email, fullName) {
            return users.upsert(email, fullName);
        },

        /** The updated user, or undefined (not null, as the store always returned) when there is none. */
        setUserName(email, fullName) {
            return users.setName(email, fullName) ?? undefined;
        },

        close() {
            database.close();
        },
    };
}
