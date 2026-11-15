import { StoreError } from '../../domain/errors.js';

// Error middleware. handleStoreError sits at the end of the entities router; the final handler
// built by createErrorHandler sits at the end of the whole app.

/**
 * A write the store refused (wrong type, unknown room, duplicate member, ...) is the caller's
 * fault, so it gets the StoreError's 400 or 409 instead of the app's 500. Anything else goes on
 * to the final handler.
 */
// Express recognises error handlers by their four parameters.
export function handleStoreError(error, req, res, next) {
    if (!(error instanceof StoreError)) {
        next(error);
        return;
    }
    res.status(error.status).json(error.toBody());
}

/**
 * The final error handler: a malformed or oversized JSON body is the client's fault (400, 413);
 * anything else is logged and answered with 500, or the response is ended when it already started.
 */
export function createErrorHandler(logger) {
    // Express recognises error handlers by their four parameters.
    return function handleError(error, req, res, next) {
        if (error.type === 'entity.parse.failed') {
            res.status(400).json({ message: 'Invalid JSON body' });
            return;
        }
        if (error.type === 'entity.too.large') {
            res.status(413).json({ message: 'Request body too large' });
            return;
        }

        logger.error(`Unhandled error on ${req.method} ${req.originalUrl}`, error);
        if (res.headersSent) {
            res.end();
            return;
        }
        res.status(500).json({ message: 'Internal server error' });
    };
}
