// The last handlers in the Express chain: unknown /api paths and errors no route handled.

/** Answers an unknown /api path (mounted behind requireUser, as the contract says). */
export function apiNotFound(req, res) {
    res.status(404).json({ message: 'Not found' });
}

/**
 * The final error handler: a malformed or oversized JSON body is the client's fault (400, 413);
 * anything else is logged and answered with 500, or the response is ended when it already started.
 */
export function createErrorHandler(logger) {
    // Express recognises error handlers by their four parameters.
    // eslint-disable-next-line no-unused-vars
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
