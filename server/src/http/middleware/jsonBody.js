import { isPlainObject } from '../../lib/query.js';

// Route middleware that checks the shape of a parsed JSON body before the handler reads it. Each
// route keeps its own 400 message (see docs/backend-contract.md), so the message is an option.

/** Answers 400 with `{ message }`, plus `code` when one is given. */
function sendBadBody(res, message, code) {
    const body = { message };
    if (code !== undefined) {
        body.code = code;
    }
    res.status(400).json(body);
}

/**
 * The body must be a JSON object, or the request is answered 400 with `message` (and `code`).
 * With `missingAsEmpty`, a request that sent no body (req.body undefined) goes on with
 * req.body = {}, as the game actions take an empty body to mean "no arguments".
 */
export function requireObjectBody({ message, code, missingAsEmpty = false }) {
    return function objectBody(req, res, next) {
        const isMissing = req.body === undefined;
        if (missingAsEmpty && isMissing) {
            req.body = {};
            next();
            return;
        }

        if (!isPlainObject(req.body)) {
            sendBadBody(res, message, code);
            return;
        }
        next();
    };
}

/** The body must be a JSON array whose items are all objects, or the request is answered 400. */
export function requireArrayOfObjectsBody({ message }) {
    return function arrayOfObjectsBody(req, res, next) {
        const isArrayOfObjects = Array.isArray(req.body) && req.body.every(isPlainObject);
        if (!isArrayOfObjects) {
            sendBadBody(res, message);
            return;
        }
        next();
    };
}
