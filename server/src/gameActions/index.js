import express from 'express';
import { ActionRegistry } from '../actions/ActionRegistry.js';
import { isPlainObject } from '../lib/query.js';
import { joinAction, kickAction, leaveAction, makeHostAction, reorderAction } from './players.js';
import {
    closeAction,
    createRoom,
    deleteAction,
    lookupRoomByCode,
    setGameModeAction,
    startAction,
} from './rooms.js';
import { createRoomActionRunner } from './roomTx.js';
import {
    editScoreAction,
    endGameAction,
    forceNextRoundAction,
    playAgainAction,
    reopenGameAction,
    retractScoreAction,
    setEditModeAction,
    setGamesWonAction,
    submitScoreAction,
} from './scoring.js';

// Routes for /api/rooms and /api/admin. Mounted after requireUser, so req.user is set.

export const ACTIONS = {
    join: joinAction,
    leave: leaveAction,
    kick: kickAction,
    'make-host': makeHostAction,
    reorder: reorderAction,
    'set-game-mode': setGameModeAction,
    start: startAction,
    close: closeAction,
    delete: deleteAction,
    'submit-score': submitScoreAction,
    'retract-score': retractScoreAction,
    'force-next-round': forceNextRoundAction,
    'set-edit-mode': setEditModeAction,
    'edit-score': editScoreAction,
    'end-game': endGameAction,
    'reopen-game': reopenGameAction,
    'play-again': playAgainAction,
    'set-games-won': setGamesWonAction,
};

// --- Handlers ------------------------------------------------------------

/** An `{ access, allowedStatuses, run(tx, body) }` action as a handler for RoomActionRunner. */
function toHandler(action) {
    return {
        access: action.access,
        allowedStatuses: action.allowedStatuses,
        handle(work, body) {
            return action.run(work, body);
        },
    };
}

/** Every action in ACTIONS, by name. */
function createActionRegistry() {
    const registry = new ActionRegistry();
    for (const [name, action] of Object.entries(ACTIONS)) {
        registry.add(name, toHandler(action));
    }
    return registry;
}

/** POST /api/rooms: open to anyone signed in, and there is no room yet whose status to check. */
const CREATE_ROOM_HANDLER = {
    access: 'signed_in',
    allowedStatuses: null,
    handle(work, body) {
        return createRoom(work, body);
    },
};

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
// `actions` is { runner, registry }: a RoomActionRunner and the ActionRegistry of ACTIONS.

function handleCreateRoom(actions, req, res) {
    const body = readBody(req);
    if (!body) {
        sendBadBody(res);
        return;
    }

    const request = { user: req.user, roomId: null, body };
    sendResult(res, actions.runner.run(CREATE_ROOM_HANDLER, request));
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

export function createRoomsRouter(context) {
    const actions = { runner: createRoomActionRunner(context), registry: createActionRegistry() };
    const router = express.Router();

    router.post('/', (req, res) => handleCreateRoom(actions, req, res));
    router.get('/by-code/:code', (req, res) => {
        sendResult(res, lookupRoomByCode(context.store, req.user, req.params.code));
    });
    router.post('/:roomId/actions/:name', (req, res) => handleAction(actions, req, res));

    return router;
}
