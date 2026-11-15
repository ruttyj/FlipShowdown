import { QueryError, parseListQuery } from '../../lib/query.js';
import { handleStoreError } from '../middleware/errorHandler.js';
import { requireArrayOfObjectsBody, requireObjectBody } from '../middleware/jsonBody.js';
import { Controller } from './Controller.js';

// /api/entities: the generic record API over the EntityService. Mounted behind requireUser, so
// req.user is set. On each route the LOCK_GAME_ENTITIES guard runs before the body check, so a
// locked-out write is a 403 whatever its body.

const objectBody = requireObjectBody({ message: 'Body must be a JSON object' });
const arrayOfObjectsBody = requireArrayOfObjectsBody({ message: 'Body must be a JSON array of objects' });

function sendError(res, status, message) {
    res.status(status).json({ message });
}

/**
 * Route middleware: sets req.listQuery to the parsed list query (filter, sort, skip, limit), or
 * answers 400 with the parser message. It runs before the lock-down guard, which reads the filter;
 * a malformed query is a 400 whether or not the lock applies.
 */
function parseQuery(req, res, next) {
    try {
        req.listQuery = parseListQuery(req.query);
    } catch (error) {
        if (error instanceof QueryError) {
            sendError(res, 400, error.message);
            return;
        }
        throw error;
    }
    next();
}

/** Route middleware: goes on when `isAllowed(req)` (the LOCK_GAME_ENTITIES rule), else 403. */
function allowIf(isAllowed) {
    return function lockdownGuard(req, res, next) {
        if (!isAllowed(req)) {
            res.status(403).json({ message: 'Not allowed', code: 'forbidden' });
            return;
        }
        next();
    };
}

export class EntitiesController extends Controller {
    /** `entities` is the EntityService. */
    constructor({ entities }) {
        super();
        this.entities = entities;
    }

    routes(router) {
        router.param('name', (req, res, next, name) => this.findEntity(req, res, next, name));

        const canBulkCreate = (req) => this.entities.canBulkCreate(req.user, req.entityName, req.body);
        const canList = (req) => this.entities.canList(req.user, req.entityName, req.listQuery);
        const canCreate = (req) => this.entities.canCreate(req.user, req.entityName, req.body);
        const canGet = (req) => this.entities.canGet(req.user, req.entityName, req.params.id);
        const canModify = (req) => this.entities.canModify(req.user, req.entityName);

        router.post('/:name/bulk', allowIf(canBulkCreate), arrayOfObjectsBody, (req, res) => this.bulkCreate(req, res));
        router.get('/:name', parseQuery, allowIf(canList), (req, res) => this.list(req, res));
        router.post('/:name', allowIf(canCreate), objectBody, (req, res) => this.create(req, res));
        router.get('/:name/:id', allowIf(canGet), (req, res) => this.get(req, res));
        router.put('/:name/:id', allowIf(canModify), objectBody, (req, res) => this.update(req, res));
        router.delete('/:name/:id', allowIf(canModify), (req, res) => this.remove(req, res));
        router.use(handleStoreError);
    }

    /** Sets req.entityName, or answers 404 for a name the API doesn't serve. */
    findEntity(req, res, next, name) {
        if (!this.entities.isEntity(name)) {
            sendError(res, 404, `Unknown entity: ${name}`);
            return;
        }
        req.entityName = name;
        next();
    }

    list(req, res) {
        res.json(this.entities.list(req.entityName, req.listQuery));
    }

    get(req, res) {
        const record = this.entities.get(req.entityName, req.params.id);
        if (!record) {
            sendError(res, 404, 'Record not found');
            return;
        }
        res.json(record);
    }

    create(req, res) {
        const [record] = this.entities.create(req.entityName, [req.body], req.user.email);
        res.status(201).json(record);
    }

    bulkCreate(req, res) {
        const records = this.entities.create(req.entityName, req.body, req.user.email);
        res.status(201).json(records);
    }

    update(req, res) {
        const record = this.entities.update(req.entityName, req.params.id, req.body);
        if (!record) {
            sendError(res, 404, 'Record not found');
            return;
        }
        res.json(record);
    }

    remove(req, res) {
        const deleted = this.entities.remove(req.entityName, req.params.id);
        if (!deleted) {
            sendError(res, 404, 'Record not found');
            return;
        }
        res.json({ success: true });
    }
}

