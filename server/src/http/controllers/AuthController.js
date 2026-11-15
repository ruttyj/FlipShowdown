import express from 'express';
import { SESSION_COOKIE, normaliseName, sessionCookieOptions } from '../../services/auth.js';
import { renderCloudflareInfoPage, renderDevLoginPage } from '../loginPage.js';
import { requireObjectBody } from '../middleware/jsonBody.js';
import { safeRedirectTarget } from '../safeRedirect.js';
import { Controller } from './Controller.js';

// Signing in and out. routes() is the /api/auth API; loginRouter() is the /login page at the app
// root, whose form posts (dev mode only) start a session cookie.

const CLOUDFLARE_LOGOUT_URL = '/cdn-cgi/access/logout';
const NAME_BODY_MESSAGE = 'Body must be an object with an optional string full_name';

// --- Helpers -------------------------------------------------------------

function requestOrigin(req) {
    return `${req.protocol}://${req.get('host')}`;
}

function sendHtml(res, status, html) {
    res.status(status).set('Cache-Control', 'no-store').type('html').send(html);
}

/** A form or query field as a string, or '' when it is missing or repeated. */
function stringField(value) {
    if (typeof value === 'string') {
        return value;
    }
    return '';
}

// --- Controller ----------------------------------------------------------

export class AuthController extends Controller {
    /**
     * `users` is the UserService, `authenticator` checks a request's credentials, `requireUser` is
     * the auth middleware and `authMode` the AUTH_MODE setting ('dev' or 'cloudflare').
     */
    constructor({ users, authenticator, requireUser, authMode }) {
        super();
        this.users = users;
        this.authenticator = authenticator;
        this.requireUser = requireUser;
        this.authMode = authMode;
    }

    /** /api/auth, behind the global JSON parser. */
    routes(router) {
        const nameBody = requireObjectBody({ message: NAME_BODY_MESSAGE, optionalStringFields: ['full_name'] });

        router.get('/me', this.requireUser, (req, res) => this.getMe(req, res));
        router.put('/me', this.requireUser, nameBody, (req, res) => this.updateMe(req, res));
        // Logout works without a valid session so a stale cookie can always be cleared.
        router.post('/logout', (req, res) => this.logout(req, res));
    }

    /** A new router with the /login page, for the app root. */
    loginRouter() {
        const router = express.Router();

        router.get('/login', (req, res) => this.showLogin(req, res));
        if (this.authMode === 'dev') {
            router.post(
                '/login',
                express.urlencoded({ extended: false, limit: '16kb' }),
                (req, res) => this.submitDevLogin(req, res),
            );
        }

        return router;
    }

    // --- /api/auth -------------------------------------------------------

    getMe(req, res) {
        res.json(this.users.toResponse(req.user));
    }

    updateMe(req, res) {
        const user = this.users.rename(req.user, req.body.full_name);
        res.json(this.users.toResponse(user));
    }

    logout(req, res) {
        if (this.authMode === 'cloudflare') {
            res.json({ logout_url: CLOUDFLARE_LOGOUT_URL });
            return;
        }

        res.clearCookie(SESSION_COOKIE, { path: '/' });
        res.json({ logout_url: null });
    }

    // --- /login ----------------------------------------------------------

    /**
     * Cloudflare mode: a signed-in visitor goes straight back to `from_url`; anyone else gets the
     * info page. Dev mode: the sign-in form.
     */
    async showLogin(req, res) {
        const fromUrl = stringField(req.query.from_url);

        if (this.authMode === 'cloudflare') {
            const identity = await this.authenticator.authenticate(req.headers);
            if (identity) {
                res.redirect(303, safeRedirectTarget(fromUrl, requestOrigin(req)));
                return;
            }
            sendHtml(res, 200, renderCloudflareInfoPage());
            return;
        }

        sendHtml(res, 200, renderDevLoginPage({ fromUrl }));
    }

    /** The dev sign-in form: sets the session cookie and redirects, or shows the form again. */
    submitDevLogin(req, res) {
        const body = req.body || {};
        const fromUrl = stringField(body.from_url);

        const token = this.users.startDevSession(body.email, body.full_name);
        if (!token) {
            // The form comes back with the name trimmed and capped, as it would have been stored.
            const page = renderDevLoginPage({
                fromUrl,
                email: stringField(body.email),
                fullName: normaliseName(body.full_name) || '',
                error: 'Please enter a valid email address.',
            });
            sendHtml(res, 400, page);
            return;
        }

        res.cookie(SESSION_COOKIE, token, sessionCookieOptions(req.secure));
        res.redirect(303, safeRedirectTarget(fromUrl, requestOrigin(req)));
    }
}
