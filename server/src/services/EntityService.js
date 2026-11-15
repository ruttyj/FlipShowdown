import { CHAT_MESSAGE, PLAYER, ROOM, ROUND_SCORE } from '../domain/entities.js';
import { isPlainObject, matchesFilter, paginate, sortEntries } from '../lib/query.js';
import { EntityGateway } from '../repositories/EntityGateway.js';

// The generic entity API behind /api/entities: who may reach which records while
// LOCK_GAME_ENTITIES is on, the reads and writes themselves, and the realtime events a write sends.

// With the lock on, non-admins reach game data only through the game actions, apart from reads of
// rooms they belong to and their own chat messages.
const LOCKED_WRITE_ENTITIES = new Set([ROOM, PLAYER, ROUND_SCORE]);

export class EntityService {
    /**
     * `store` is the db.js store. Reads and writes go through its repositories (an EntityGateway
     * over them), except create (see there). `hub` is the realtime hub, called through the object
     * at call time, so a test that replaces one of its methods reaches this code too.
     * `entityNames` is the Set of entity names the API serves. `lockGameEntities` is the
     * LOCK_GAME_ENTITIES flag and `adminEmails` the Set of addresses it doesn't apply to.
     */
    constructor({ store, hub, entityNames, lockGameEntities, adminEmails }) {
        this.store = store;
        this.rooms = store.repositories.rooms;
        this.players = store.repositories.players;
        this.entities = new EntityGateway(store.database, store.repositories);
        this.hub = hub;
        this.entityNames = entityNames;
        this.lockGameEntities = lockGameEntities;
        this.adminEmails = adminEmails;
    }

    /** Whether the API serves this entity name. */
    isEntity(name) {
        return this.entityNames.has(name);
    }

    // --- Lock-down (LOCK_GAME_ENTITIES) ----------------------------------
    // Each can* method is true when the lock doesn't apply to this user and entity. A request
    // whose body is malformed passes, so its route answers 400 rather than 403. (A malformed list
    // query never gets here: the route answers 400 before the check.)

    /** Whether the lock applies: it is on, the entity is game data and the user isn't an admin. */
    #isLockedFor(user, entityName) {
        const isGameEntity = LOCKED_WRITE_ENTITIES.has(entityName) || entityName === CHAT_MESSAGE;
        if (!this.lockGameEntities || !isGameEntity) {
            return false;
        }
        return !this.adminEmails.has(user.email);
    }

    /** The user's Player in the room, or null. */
    #findMemberPlayer(roomId, email) {
        if (typeof roomId !== 'string') {
            return null;
        }

        const players = this.players.listByRoom(roomId);
        return players.find((player) => player.email === email) || null;
    }

    #isRoomMember(roomId, email) {
        return this.#findMemberPlayer(roomId, email) !== null;
    }

    /** Whether the user is a member of every room that has this join code (and there is one). */
    #isMemberOfRoomsWithCode(code, email) {
        if (typeof code !== 'string') {
            return false;
        }

        const rooms = this.rooms.findByCode(code);
        if (rooms.length === 0) {
            return false;
        }
        return rooms.every((room) => this.#isRoomMember(room.id, email));
    }

    /** A chat message must go to a room the user is in, sent as the user's Player. */
    #isOwnChatMessage(message, email) {
        const player = this.#findMemberPlayer(message.room_id, email);
        return player !== null && message.sender_id === player.id;
    }

    /**
     * A list read (`query` as parseListQuery returns it) must name a room the user belongs to. The
     * client never looks rooms up by code through this route (the join screen uses the rooms
     * API), so a `code` read needs membership like any other.
     */
    canList(user, entityName, query) {
        if (!this.#isLockedFor(user, entityName)) {
            return true;
        }

        const filter = query.filter;
        if (entityName !== ROOM) {
            return this.#isRoomMember(filter.room_id, user.email);
        }
        if (Object.hasOwn(filter, 'id')) {
            return this.#isRoomMember(filter.id, user.email);
        }
        return this.#isMemberOfRoomsWithCode(filter.code, user.email);
    }

    /** A read by id must be of a room the user is in, or of a record in one. */
    canGet(user, entityName, id) {
        if (!this.#isLockedFor(user, entityName)) {
            return true;
        }

        if (entityName === ROOM) {
            return this.#isRoomMember(id, user.email);
        }

        const record = this.entities.get(entityName, id);
        if (!record) {
            // The route answers 404.
            return true;
        }
        return this.#isRoomMember(record.room_id, user.email);
    }

    /** Only the user's own chat messages may be created. */
    canCreate(user, entityName, body) {
        if (!this.#isLockedFor(user, entityName)) {
            return true;
        }

        if (entityName !== CHAT_MESSAGE) {
            return false;
        }
        if (!isPlainObject(body)) {
            return true;
        }
        return this.#isOwnChatMessage(body, user.email);
    }

    /** Only chat messages that are all the user's own may be created in bulk. */
    canBulkCreate(user, entityName, body) {
        if (!this.#isLockedFor(user, entityName)) {
            return true;
        }

        if (entityName !== CHAT_MESSAGE) {
            return false;
        }
        const isArrayOfObjects = Array.isArray(body) && body.every(isPlainObject);
        if (!isArrayOfObjects) {
            return true;
        }
        return body.every((message) => this.#isOwnChatMessage(message, user.email));
    }

    /** Updates and deletes are for admins only. */
    canModify(user, entityName) {
        return !this.#isLockedFor(user, entityName);
    }

    // --- Membership events -----------------------------------------------

    /**
     * Creating or deleting a Player adds someone to a room or removes them, so the hub re-checks
     * that room's subscriptions and resends its presence.
     */
    #notifyMembership(entityName, record) {
        const isRoomPlayer = entityName === PLAYER && typeof record.room_id === 'string';
        if (isRoomPlayer) {
            this.hub.roomMembershipChanged(record.room_id);
        }
    }

    /**
     * A Player update that moves it to another room or another user changes membership in both
     * the old room and the new one.
     */
    #notifyMembershipMove(entityName, before, after) {
        if (entityName !== PLAYER) {
            return;
        }

        const isMoved = before.room_id !== after.room_id || before.email !== after.email;
        if (!isMoved) {
            return;
        }
        this.#notifyMembership(entityName, before);
        if (after.room_id !== before.room_id) {
            this.#notifyMembership(entityName, after);
        }
    }

    // --- Reads and writes ------------------------------------------------
    // A write the store refuses throws its StoreError (400 or 409).

    /** One page of records matching `query` (parsed by parseListQuery: filter, sort, skip, limit). */
    list(entityName, query) {
        const matching = [];
        for (const entry of this.entities.list(entityName)) {
            if (matchesFilter(entry.record, query.filter)) {
                matching.push(entry);
            }
        }

        const sorted = sortEntries(matching, query.sort);
        const page = paginate(sorted, query.skip, query.limit);
        return page.map((entry) => entry.record);
    }

    /** The record, or null. */
    get(entityName, id) {
        return this.entities.get(entityName, id);
    }

    /** Creates every item or none, then publishes each new record; returns the records. */
    create(entityName, items, createdBy) {
        // Through the store facade, not this.entities.insertMany: coverageGaps.test replaces
        // store.createRecords on a running server to make a write fail with a plain Error.
        const records = this.store.createRecords(entityName, items, createdBy);
        for (const record of records) {
            this.hub.publish(entityName, 'create', record);
            this.#notifyMembership(entityName, record);
        }
        return records;
    }

    /** The updated record (published), or null when there is no such record. */
    update(entityName, id, changes) {
        const before = this.entities.get(entityName, id);
        const record = this.entities.update(entityName, id, changes);
        if (!record) {
            return null;
        }

        this.hub.publish(entityName, 'update', record);
        this.#notifyMembershipMove(entityName, before, record);
        return record;
    }

    /** Deletes the record and returns it as it was (published), or null when there was none. */
    remove(entityName, id) {
        const deleted = this.entities.delete(entityName, id);
        if (!deleted) {
            return null;
        }

        // Subscribers get the pre-deletion record (the app reads event.data.room_id).
        this.hub.publish(entityName, 'delete', deleted);
        this.#notifyMembership(entityName, deleted);
        return deleted;
    }
}
