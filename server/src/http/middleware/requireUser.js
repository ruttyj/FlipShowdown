// Every /api route except /api/health and /api/auth/logout sits behind this (the WebSocket upgrade
// authenticates on its own): it turns the request's credentials into req.user or answers 401.

/**
 * Express middleware: authenticates the request, creates the user on first sight and sets
 * req.user (a users row), or answers 401. `authenticator.authenticate(headers)` resolves to an
 * identity ({ email, full_name }) or null; `users` is the UserService.
 */
export function createRequireUser({ authenticator, users }) {
    return async function requireUser(req, res, next) {
        const identity = await authenticator.authenticate(req.headers);
        if (!identity) {
            res.status(401).json({ message: 'Authentication required' });
            return;
        }

        req.user = users.findOrCreate(identity);
        next();
    };
}
