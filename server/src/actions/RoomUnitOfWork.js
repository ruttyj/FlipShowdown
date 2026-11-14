import { CHAT_MESSAGE, PLAYER, ROOM, ROUND_SCORE } from '../domain/entities.js';
import { ActionError } from '../domain/errors.js';

// One game action's work on one room. It holds the caller, the room, the room changes staged
// until commit and the realtime events the action's writes queued. Every write goes through it
// to the repositories, so each one is recorded as an event exactly once. RoomActionRunner runs
// it inside one database transaction and publishes `events` only after that commits.

// --- Change tracking -----------------------------------------------------

function isSameValue(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

/** The subset of `changes` whose values differ from `record`. */
function diffFields(record, changes) {
    const diff = {};
    for (const [field, value] of Object.entries(changes)) {
        if (!isSameValue(record[field], value)) {
            diff[field] = value;
        }
    }
    return diff;
}

function hasFields(diff) {
    return Object.keys(diff).length > 0;
}

// --- Unit of work --------------------------------------------------------

export class RoomUnitOfWork {
    // The repositories of the room's children, by entity name.
    #childRepositories;
    #rooms;
    #players;

    // The room's host_email before the action, or null for a room the action creates.
    #initialHostEmail = null;
    // The type of the room's own event: 'create' once insertRoom made the room.
    #roomEventType = 'update';
    #pendingRoomChanges = {};
    #versionBumped = false;
    #roomDeleted = false;
    // Whether anything was written, so the room's version needs a bump at the end.
    #changed = false;

    /**
     * `repositories` is the store's repositories (rooms, players, roundScores and chatMessages
     * are used). `user` is the caller's users row, or SYSTEM_USER for a system action, and
     * `isAdmin` whether that caller is an admin. `store` is the store facade, kept as `this.store`
     * because rooms.js still reads `tx.store` to pick a room code (until P3.2) and loadRoom reads
     * through it (see there).
     */
    constructor({ repositories, store, user, isAdmin }) {
        this.store = store;
        this.user = user;
        this.isAdmin = isAdmin;
        // Services read `room` but change it only through the methods below. The room acted on: set by loadRoom or insertRoom, and kept current by every room write.
        this.room = null;
        // Runner only (services must not touch it). What to publish after commit, in order: { entity, type, record }, one per record.
        this.events = [];

        this.#rooms = repositories.rooms;
        this.#players = repositories.players;
        this.#childRepositories = new Map([
            [PLAYER, repositories.players],
            [ROUND_SCORE, repositories.roundScores],
            [CHAT_MESSAGE, repositories.chatMessages],
        ]);
    }

    // --- Events ----------------------------------------------------------

    #findEventIndex(entity, id) {
        return this.events.findIndex((event) => event.entity === entity && event.record.id === id);
    }

    /**
     * Queues a realtime event, keeping one event per record: a later update replaces the queued
     * record in place, and a delete drops whatever was queued before (a record created and
     * deleted in one action publishes nothing).
     */
    #queueEvent(entity, type, record) {
        const index = this.#findEventIndex(entity, record.id);
        if (index === -1) {
            this.events.push({ entity, type, record });
            return;
        }

        const existing = this.events[index];
        if (type === 'update') {
            existing.record = record;
            return;
        }

        this.events.splice(index, 1);
        if (existing.type !== 'create') {
            this.events.push({ entity, type, record });
        }
    }

    // --- Child records (Player, RoundScore, ChatMessage) -------------------

    /** The repository for a child entity. Throws for any other entity, so a typo can't write elsewhere. */
    #childRepository(entity) {
        const repository = this.#childRepositories.get(entity);
        if (!repository) {
            throw new Error(`Not a room child entity: ${entity}`);
        }
        return repository;
    }

    createChild(entity, fields) {
        const record = this.#childRepository(entity).insert(fields, this.user.email);
        this.#changed = true;
        this.#queueEvent(entity, 'create', record);
        return record;
    }

    /** Writes only the fields that differ. Returns the current record either way. */
    updateChild(entity, record, changes) {
        // Looked up first, so a wrong entity throws even when nothing would change.
        const repository = this.#childRepository(entity);
        const diff = diffFields(record, changes);
        if (!hasFields(diff)) {
            return record;
        }

        const updated = repository.update(record.id, diff);
        this.#changed = true;
        this.#queueEvent(entity, 'update', updated);
        return updated;
    }

    /** Deletes the record. A record that is already gone changes nothing and queues nothing. */
    deleteChild(entity, record) {
        const deleted = this.#childRepository(entity).delete(record.id);
        if (!deleted) {
            return;
        }

        this.#changed = true;
        this.#queueEvent(entity, 'delete', deleted);
    }

    /** Every record of `entity` whose room_id is the current room, oldest first. */
    listRoomChildren(entity) {
        return this.#childRepository(entity).listByRoom(this.room.id);
    }

    // --- Players ---------------------------------------------------------

    /** The room's players sorted by turn_order. */
    listPlayers() {
        return this.#players.listByRoomInTurnOrder(this.room.id);
    }

    /** The caller's Player in the room, or null. */
    findCallerPlayer() {
        const players = this.#players.listByRoom(this.room.id);
        return players.find((player) => player.email === this.user.email) || null;
    }

    /** The room's Player with this id, or a 404 `player_not_found`. */
    getRoomPlayer(playerId) {
        const player = this.#players.get(playerId);
        if (!player || player.room_id !== this.room.id) {
            throw new ActionError(404, 'player_not_found', 'Player not found');
        }
        return player;
    }

    // --- The room record -------------------------------------------------

    /**
     * Inserts a new GameRoom and makes it the action's room. It is published as a `create` event
     * (last, like any room change) when the action finishes.
     */
    insertRoom(fields) {
        const room = this.#rooms.insert({ ...fields, version: 0 }, this.user.email);
        this.room = room;
        this.#roomEventType = 'create';
        this.#changed = true;
        return room;
    }

    /** Stages room changes; they are written once, with the version bump, by flushRoom. */
    updateRoom(changes) {
        const diff = diffFields(this.room, changes);
        if (!hasFields(diff)) {
            return;
        }

        Object.assign(this.#pendingRoomChanges, diff);
        this.room = { ...this.room, ...diff };
        this.#changed = true;
    }

    /**
     * Writes the staged room changes now, bumping `version` and `last_activity_date` once per
     * action, and queues the room's event at the current position. Normally finish does this
     * last; `delete` calls it early so the `closed` update goes out before the deletes.
     */
    flushRoom() {
        const changes = { ...this.#pendingRoomChanges };
        if (!this.#versionBumped) {
            changes.version = (this.room.version ?? 0) + 1;
            changes.last_activity_date = new Date().toISOString();
            this.#versionBumped = true;
        }

        this.room = this.#rooms.update(this.room.id, changes);
        this.#pendingRoomChanges = {};
        this.#queueEvent(ROOM, this.#roomEventType, this.room);
    }

    /** Deletes the room record itself. Call flushRoom first so the version is final. */
    deleteRoomRecord() {
        const deleted = this.#rooms.delete(this.room.id);
        this.#roomDeleted = true;
        // Pushed directly rather than through #queueEvent: the `closed` update queued by
        // flushRoom must still go out before the deletes.
        this.events.push({ entity: ROOM, type: 'delete', record: deleted });
    }

    // --- Status ----------------------------------------------------------

    /** allowedStatuses: list of statuses, or null for any. Throws a 409 `wrong_status` otherwise. */
    requireStatus(allowedStatuses) {
        if (allowedStatuses === null || allowedStatuses.includes(this.room.status)) {
            return;
        }
        throw new ActionError(409, 'wrong_status', `Not allowed while the room is ${this.room.status}`, {
            status: this.room.status,
        });
    }

    // --- Runner only ------------------------------------------------------
    // RoomActionRunner calls these around the handler. Services must not: the runner loads the
    // room before the handler, finishes after it and publishes what changed after commit.

    /** Makes the room with this id the action's room, or throws a 404 `room_not_found`. */
    loadRoom(roomId) {
        // Read through the store facade rather than RoomRepository: staleRooms.test makes one
        // room fail to load by replacing store.getRecord. Move to this.#rooms.get when the tests
        // stop using the facade (P6.1).
        const room = this.store.getRecord(ROOM, roomId);
        if (!room) {
            throw new ActionError(404, 'room_not_found', 'Room not found');
        }
        this.room = room;
        this.#initialHostEmail = room.host_email;
    }

    /** Ends the action's writes: flushes the room if anything changed and it still exists. */
    finish() {
        if (this.#roomDeleted || !this.#changed) {
            return;
        }
        this.flushRoom();
    }

    /** The room's version, for the published events. */
    get roomVersion() {
        return this.room.version;
    }

    /** Whether a Player was created or deleted (a join, leave or kick). */
    hasMembershipChange() {
        return this.events.some((event) => event.entity === PLAYER && event.type !== 'update');
    }

    /** Whether an existing room's host_email changed. A room the action created has no previous host. */
    hasHostChange() {
        const isExistingRoom = this.#initialHostEmail !== null;
        return isExistingRoom && this.room.host_email !== this.#initialHostEmail;
    }
}
