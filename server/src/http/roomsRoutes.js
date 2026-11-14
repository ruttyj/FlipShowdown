import express from 'express';
import { isPlainObject } from '../lib/query.js';

// Routes under /api/rooms. Mounted after requireUser, so req.user is set.

// --- Responses -----------------------------------------------------------

function sendResult(res, result) {
    res.status(result.status).json(result.body);
}

function sendBadBody(res) {
    res.status(400).json({ message: 'Body must be a JSON object', code: 'bad_request' });
}

/** The JSON body, treating a missing body as {}. Null when it isn't an object. */
function readBody(req) {
    if (req.body === undefined) {
        return {};
    }
    if (!isPlainObject(req.body)) {
        return null;
    }
    return req.body;
}

// --- Rooms ---------------------------------------------------------------
// `actions` is { runner, registry, createRoom, lookupByCode } (see providers/HttpProvider.js).

function handleCreateRoom(actions, req, res) {
    const body = readBody(req);
    if (!body) {
        sendBadBody(res);
        return;
    }

    const request = { user: req.user, roomId: null, body };
    sendResult(res, actions.runner.run(actions.createRoom, request));
}

function handleLookupByCode(actions, req, res) {
    sendResult(res, actions.lookupByCode.lookup(req.user, req.params.code));
}

function handleAction(actions, req, res) {
    const handler = actions.registry.get(req.params.name);
    if (!handler) {
        res.status(404).json({ message: `Unknown action: ${req.params.name}` });
        return;
    }

    const body = readBody(req);
    if (!body) {
        sendBadBody(res);
        return;
    }

    const request = { user: req.user, roomId: req.params.roomId, body };
    sendResult(res, actions.runner.run(handler, request));
}

/** The /api/rooms router over the game actions (see providers/GameProvider.js). */
export function createRoomsRouter(actions) {
    const router = express.Router();

    router.post('/', (req, res) => handleCreateRoom(actions, req, res));
    router.get('/by-code/:code', (req, res) => handleLookupByCode(actions, req, res));
    router.post('/:roomId/actions/:name', (req, res) => handleAction(actions, req, res));

    return router;
}
