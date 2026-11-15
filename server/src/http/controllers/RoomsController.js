import { requireObjectBody } from '../middleware/jsonBody.js';
import { Controller } from './Controller.js';

// /api/rooms: creating a room, finding one by join code, and the game actions, each run by the
// RoomActionRunner. Mounted behind requireUser, so req.user is set.

// A missing body means "no arguments"; anything else must be an object.
const actionBody = requireObjectBody({
    message: 'Body must be a JSON object',
    code: 'bad_request',
    missingAsEmpty: true,
});

/** Answers with a game action's { status, body }. */
function sendResult(res, result) {
    res.status(result.status).json(result.body);
}

export class RoomsController extends Controller {
    /**
     * `runner` is the RoomActionRunner, `registry` the ActionRegistry of action handlers,
     * `createRoom` the CreateRoomAction and `lookupByCode` the LookupByCodeAction.
     */
    constructor({ runner, registry, createRoom, lookupByCode }) {
        super();
        this.runner = runner;
        this.registry = registry;
        this.createRoomAction = createRoom;
        this.lookupByCodeAction = lookupByCode;
    }

    routes(router) {
        // Runs before the action route's body check, so an unknown action is a 404 whatever the body.
        router.param('name', (req, res, next, name) => this.findAction(req, res, next, name));

        router.post('/', actionBody, (req, res) => this.createRoom(req, res));
        router.get('/by-code/:code', (req, res) => this.lookupByCode(req, res));
        router.post('/:roomId/actions/:name', actionBody, (req, res) => this.runAction(req, res));
    }

    /** Sets req.roomAction to the named action's handler, or answers 404. */
    findAction(req, res, next, name) {
        const handler = this.registry.get(name);
        if (!handler) {
            res.status(404).json({ message: `Unknown action: ${name}` });
            return;
        }
        req.roomAction = handler;
        next();
    }

    createRoom(req, res) {
        const request = { user: req.user, roomId: null, body: req.body };
        sendResult(res, this.runner.run(this.createRoomAction, request));
    }

    lookupByCode(req, res) {
        sendResult(res, this.lookupByCodeAction.lookup(req.user, req.params.code));
    }

    runAction(req, res) {
        const request = { user: req.user, roomId: req.params.roomId, body: req.body };
        sendResult(res, this.runner.run(req.roomAction, request));
    }
}
