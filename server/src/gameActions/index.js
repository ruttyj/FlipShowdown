import express from 'express';
import { ActionRegistry } from '../actions/ActionRegistry.js';
import { createPlayerActions } from '../actions/players/index.js';
import { CreateRoomAction, createRoomActions } from '../actions/rooms/index.js';
import { createScoringActions } from '../actions/scoring/index.js';
import { ActionError } from '../domain/errors.js';
import { isPlainObject } from '../lib/query.js';
import { PlayerService } from '../services/PlayerService.js';
import { RoomService } from '../services/RoomService.js';
import { RoundService } from '../services/RoundService.js';
import { ScoringService } from '../services/ScoringService.js';
import { TotalsService } from '../services/TotalsService.js';
import { joinAction, kickAction, leaveAction, makeHostAction, reorderAction } from './players.js';
import { closeAction, deleteAction, setGameModeAction, startAction } from './rooms.js';
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

// Every action as the old `{ access, allowedStatuses, run(tx, body) }` object, by name, for the root
// test fixture (tests/fixtures/serverRoom.js). Each is an adapter over the same handler class the
// router runs.
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

/**
 * The game services, built once per router. RoomService reads the store's repositories; the others
 * are stateless and take the action's RoomUnitOfWork on every call.
 */
function createServices(repositories) {
    const totalsService = new TotalsService();
    const roundService = new RoundService();
    return {
        roomService: new RoomService({ roomRepository: repositories.rooms, playerRepository: repositories.players }),
        playerService: new PlayerService({ rounds: roundService, totals: totalsService }),
        scoringService: new ScoringService({ roundService, totalsService }),
        roundService,
        totalsService,
    };
}

/** Every game action's handler class, by name. */
function createActionRegistry(services) {
    const handlers = [
        ...createRoomActions(services),
        ...createPlayerActions(services),
        ...createScoringActions(services),
    ];

    const registry = new ActionRegistry();
    for (const handler of handlers) {
        registry.add(handler.name, handler);
    }
    return registry;
}

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
// `actions` is { runner, registry, createRoom, roomService }: a RoomActionRunner, the
// ActionRegistry of the game actions, the CreateRoomAction and the RoomService.

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
    let body;
    try {
        body = actions.roomService.lookupByCode(req.user.email, req.params.code);
    } catch (error) {
        if (error instanceof ActionError) {
            sendResult(res, { status: error.status, body: error.toBody() });
            return;
        }
        throw error;
    }
    sendResult(res, { status: 200, body });
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
    const services = createServices(context.store.repositories);
    const actions = {
        runner: createRoomActionRunner(context),
        registry: createActionRegistry(services),
        createRoom: new CreateRoomAction(services),
        roomService: services.roomService,
    };
    const router = express.Router();

    router.post('/', (req, res) => handleCreateRoom(actions, req, res));
    router.get('/by-code/:code', (req, res) => handleLookupByCode(actions, req, res));
    router.post('/:roomId/actions/:name', (req, res) => handleAction(actions, req, res));

    return router;
}
