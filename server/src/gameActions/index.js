import express from 'express';
import { isPlainObject } from '../query.js';
import { joinAction, kickAction, leaveAction, makeHostAction, reorderAction } from './players.js';
import {
    closeAction,
    createRoom,
    deleteAction,
    lookupRoomByCode,
    setGameModeAction,
    startAction,
} from './rooms.js';
import { runRoomAction } from './roomTx.js';
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

function handleCreateRoom(context, req, res) {
    const body = readBody(req);
    if (!body) {
        sendBadBody(res);
        return;
    }

    const request = { user: req.user, roomId: null, access: 'signed_in', allowedStatuses: null };
    sendResult(res, runRoomAction(context, request, (tx) => createRoom(tx, body)));
}

function handleAction(context, req, res) {
    const action = Object.hasOwn(ACTIONS, req.params.name) ? ACTIONS[req.params.name] : null;
    if (!action) {
        res.status(404).json({ message: `Unknown action: ${req.params.name}` });
        return;
    }

    const body = readBody(req);
    if (!body) {
        sendBadBody(res);
        return;
    }

    const request = {
        user: req.user,
        roomId: req.params.roomId,
        access: action.access,
        allowedStatuses: action.allowedStatuses,
    };
    sendResult(res, runRoomAction(context, request, (tx) => action.run(tx, body)));
}

export function createRoomsRouter(context) {
    const router = express.Router();

    router.post('/', (req, res) => handleCreateRoom(context, req, res));
    router.get('/by-code/:code', (req, res) => {
        sendResult(res, lookupRoomByCode(context.store, req.user, req.params.code));
    });
    router.post('/:roomId/actions/:name', (req, res) => handleAction(context, req, res));

    return router;
}
