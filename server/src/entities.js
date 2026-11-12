import express from 'express';
import { StoreError } from './entityTables.js';
import { QueryError, isPlainObject, matchesFilter, paginate, parseListQuery, sortEntries } from './query.js';

// Routes under /api/entities. Mounted after requireUser, so req.user is set.

function sendError(res, status, message) {
    res.status(status).json({ message });
}

/**
 * Creating or deleting a Player adds someone to a room or removes them, so the
 * hub re-checks that room's subscriptions and resends its presence.
 */
function notifyMembership(context, entityName, record) {
    const isRoomPlayer = entityName === 'Player' && typeof record.room_id === 'string';
    if (isRoomPlayer) {
        context.hub.roomMembershipChanged(record.room_id);
    }
}

/**
 * A Player update that moves it to another room or another user changes
 * membership in both the old room and the new one.
 */
function notifyMembershipMove(context, entityName, before, after) {
    if (entityName !== 'Player') {
        return;
    }

    const isMoved = before.room_id !== after.room_id || before.email !== after.email;
    if (!isMoved) {
        return;
    }
    notifyMembership(context, entityName, before);
    if (after.room_id !== before.room_id) {
        notifyMembership(context, entityName, after);
    }
}

// --- Lock-down (LOCK_GAME_ENTITIES) --------------------------------------
// With the flag on, non-admins reach game data only through the game actions,
// apart from reads of rooms they belong to and their own chat messages.

const LOCKED_WRITE_ENTITIES = new Set(['GameRoom', 'Player', 'RoundScore']);
const CHAT_MESSAGE = 'ChatMessage';

function sendForbidden(res) {
    res.status(403).json({ message: 'Not allowed', code: 'forbidden' });
}

function isLockdownActive(context, req) {
    const isGameEntity = LOCKED_WRITE_ENTITIES.has(req.entityName) || req.entityName === CHAT_MESSAGE;
    if (!context.config.lockGameEntities || !isGameEntity) {
        return false;
    }
    return !context.config.adminEmails.has(req.user.email);
}

/** The caller's Player in the room, or null. */
function findMemberPlayer(context, roomId, email) {
    if (typeof roomId !== 'string') {
        return null;
    }

    const players = context.store.findRecords('Player', 'room_id', roomId);
    return players.find((player) => player.email === email) || null;
}

function isRoomMember(context, roomId, email) {
    return findMemberPlayer(context, roomId, email) !== null;
}

/** Whether the caller is a member of every room that has this join code (and there is one). */
function isMemberOfRoomsWithCode(context, code, email) {
    if (typeof code !== 'string') {
        return false;
    }

    const rooms = context.store.findRecords('GameRoom', 'code', code);
    if (rooms.length === 0) {
        return false;
    }
    return rooms.every((room) => isRoomMember(context, room.id, email));
}

/**
 * A list read must name a room the caller belongs to. The client never looks
 * rooms up by code through this route (the join screen uses the rooms API), so
 * a `code` read needs membership like any other.
 */
function canList(context, req) {
    let filter;
    try {
        filter = parseListQuery(req.query).filter;
    } catch (error) {
        if (error instanceof QueryError) {
            // The list handler answers 400 and returns nothing.
            return true;
        }
        throw error;
    }

    const email = req.user.email;
    if (req.entityName !== 'GameRoom') {
        return isRoomMember(context, filter.room_id, email);
    }
    if (Object.hasOwn(filter, 'id')) {
        return isRoomMember(context, filter.id, email);
    }
    return isMemberOfRoomsWithCode(context, filter.code, email);
}

function canGet(context, req) {
    const email = req.user.email;
    if (req.entityName === 'GameRoom') {
        return isRoomMember(context, req.params.id, email);
    }

    const record = context.store.getRecord(req.entityName, req.params.id);
    if (!record) {
        // The handler answers 404.
        return true;
    }
    return isRoomMember(context, record.room_id, email);
}

/** A chat message must go to a room the caller is in, sent as the caller's Player. */
function isOwnChatMessage(context, message, email) {
    const player = findMemberPlayer(context, message.room_id, email);
    return player !== null && message.sender_id === player.id;
}

function canCreate(context, req) {
    if (req.entityName !== CHAT_MESSAGE) {
        return false;
    }
    if (!isPlainObject(req.body)) {
        // The handler answers 400 and creates nothing.
        return true;
    }
    return isOwnChatMessage(context, req.body, req.user.email);
}

function canBulkCreate(context, req) {
    if (req.entityName !== CHAT_MESSAGE) {
        return false;
    }

    const isArrayOfObjects = Array.isArray(req.body) && req.body.every(isPlainObject);
    if (!isArrayOfObjects) {
        // The handler answers 400 and creates nothing.
        return true;
    }
    return req.body.every((message) => isOwnChatMessage(context, message, req.user.email));
}

function canNeverModify() {
    return false;
}

/** Route middleware: while the lock is on, non-admins must pass `isAllowed(context, req)`. */
function lockdownGuard(context, isAllowed) {
    return (req, res, next) => {
        if (!isLockdownActive(context, req) || isAllowed(context, req)) {
            next();
            return;
        }
        sendForbidden(res);
    };
}

// --- Handlers ------------------------------------------------------------

function listRecords(context, req, res) {
    let query;
    try {
        query = parseListQuery(req.query);
    } catch (error) {
        if (error instanceof QueryError) {
            sendError(res, 400, error.message);
            return;
        }
        throw error;
    }

    const matching = [];
    for (const entry of context.store.listRecords(req.entityName)) {
        if (matchesFilter(entry.record, query.filter)) {
            matching.push(entry);
        }
    }

    const sorted = sortEntries(matching, query.sort);
    const page = paginate(sorted, query.skip, query.limit);
    res.json(page.map((entry) => entry.record));
}

function getRecord(context, req, res) {
    const record = context.store.getRecord(req.entityName, req.params.id);
    if (!record) {
        sendError(res, 404, 'Record not found');
        return;
    }
    res.json(record);
}

function createRecord(context, req, res) {
    if (!isPlainObject(req.body)) {
        sendError(res, 400, 'Body must be a JSON object');
        return;
    }

    const [record] = context.store.createRecords(req.entityName, [req.body], req.user.email);
    context.hub.publish(req.entityName, 'create', record);
    notifyMembership(context, req.entityName, record);
    res.status(201).json(record);
}

function bulkCreateRecords(context, req, res) {
    const isArrayOfObjects = Array.isArray(req.body) && req.body.every(isPlainObject);
    if (!isArrayOfObjects) {
        sendError(res, 400, 'Body must be a JSON array of objects');
        return;
    }

    const records = context.store.createRecords(req.entityName, req.body, req.user.email);
    for (const record of records) {
        context.hub.publish(req.entityName, 'create', record);
        notifyMembership(context, req.entityName, record);
    }
    res.status(201).json(records);
}

function updateRecord(context, req, res) {
    if (!isPlainObject(req.body)) {
        sendError(res, 400, 'Body must be a JSON object');
        return;
    }

    const before = context.store.getRecord(req.entityName, req.params.id);
    const record = context.store.updateRecord(req.entityName, req.params.id, req.body);
    if (!record) {
        sendError(res, 404, 'Record not found');
        return;
    }

    context.hub.publish(req.entityName, 'update', record);
    notifyMembershipMove(context, req.entityName, before, record);
    res.json(record);
}

function deleteRecord(context, req, res) {
    const deleted = context.store.deleteRecord(req.entityName, req.params.id);
    if (!deleted) {
        sendError(res, 404, 'Record not found');
        return;
    }

    // Subscribers get the pre-deletion record (the app reads event.data.room_id).
    context.hub.publish(req.entityName, 'delete', deleted);
    notifyMembership(context, req.entityName, deleted);
    res.json({ success: true });
}

/**
 * A write the store refused (wrong type, unknown room, duplicate member, ...) is the caller's
 * fault, so it gets the StoreError's 400 or 409 instead of the app's 500.
 */
// Express recognises error handlers by their four parameters.
// eslint-disable-next-line no-unused-vars
function handleStoreError(error, req, res, next) {
    if (!(error instanceof StoreError)) {
        next(error);
        return;
    }
    res.status(error.status).json(error.toBody());
}

// --- Router --------------------------------------------------------------

/** context = { store, hub, entities: Set<string> } */
export function createEntitiesRouter(context) {
    const router = express.Router();

    router.param('name', (req, res, next, name) => {
        if (!context.entities.has(name)) {
            sendError(res, 404, `Unknown entity: ${name}`);
            return;
        }
        req.entityName = name;
        next();
    });

    router.post('/:name/bulk', lockdownGuard(context, canBulkCreate), (req, res) => bulkCreateRecords(context, req, res));
    router.get('/:name', lockdownGuard(context, canList), (req, res) => listRecords(context, req, res));
    router.post('/:name', lockdownGuard(context, canCreate), (req, res) => createRecord(context, req, res));
    router.get('/:name/:id', lockdownGuard(context, canGet), (req, res) => getRecord(context, req, res));
    router.put('/:name/:id', lockdownGuard(context, canNeverModify), (req, res) => updateRecord(context, req, res));
    router.delete('/:name/:id', lockdownGuard(context, canNeverModify), (req, res) => deleteRecord(context, req, res));
    router.use(handleStoreError);

    return router;
}
