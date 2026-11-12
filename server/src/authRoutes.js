import express from 'express';
import {
    SESSION_COOKIE,
    createSessionToken,
    normaliseEmail,
    normaliseName,
    sessionCookieOptions,
} from './auth.js';
import { renderCloudflareInfoPage, renderDevLoginPage } from './loginPage.js';
import { isPlainObject } from './query.js';

const CLOUDFLARE_LOGOUT_URL = '/cdn-cgi/access/logout';

function sendError(res, status, message) {
    res.status(status).json({ message });
}

// --- Users ---------------------------------------------------------------

/** API shape of a users row; role is derived from ADMIN_EMAILS on every read. */
export function toUserResponse(row, adminEmails) {
    return {
        id: row.id,
        email: row.email,
        full_name: row.full_name,
        role: adminEmails.has(row.email) ? 'admin' : 'user',
        created_date: row.created_date,
        updated_date: row.updated_date,
    };
}

/**
 * Express middleware: authenticates the request, upserts the user on first
 * sight and sets req.user (a users row), or answers 401.
 */
export function createRequireUser(context) {
    return async function requireUser(req, res, next) {
        const identity = await context.authenticator.authenticate(req.headers);
        if (!identity) {
            sendError(res, 401, 'Authentication required');
            return;
        }

        let user = context.store.findUserByEmail(identity.email);
        if (!user) {
            user = context.store.upsertUser(identity.email, identity.full_name);
        }
        req.user = user;
        next();
    };
}

// --- Redirect safety -----------------------------------------------------

/**
 * Returns a same-origin path to redirect to after login, or "/" when
 * `fromUrl` is missing or points elsewhere. Examples:
 *   "/room/abc?x=1"                       -> "/room/abc?x=1"
 *   "https://<this host>/room/abc"        -> "/room/abc"
 *   "//evil.com", "/\\evil.com", "https://evil.com/" -> "/"
 */
export function safeRedirectTarget(fromUrl, requestOrigin) {
    if (typeof fromUrl !== 'string' || fromUrl === '') {
        return '/';
    }

    // Control characters can make browsers parse the URL differently than we do.
    if (/[\u0000-\u001f\u007f]/.test(fromUrl)) {
        return '/';
    }

    // A single leading slash is a path; "//" or "/\" would be protocol-relative.
    const isLocalPath = fromUrl.startsWith('/') && fromUrl[1] !== '/' && fromUrl[1] !== '\\';
    if (isLocalPath) {
        return fromUrl;
    }

    let parsed;
    try {
        parsed = new URL(fromUrl);
    } catch {
        return '/';
    }
    if (parsed.origin !== requestOrigin) {
        return '/';
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function requestOrigin(req) {
    return `${req.protocol}://${req.get('host')}`;
}

// --- /api/auth -----------------------------------------------------------

function updateMe(context, req, res) {
    const fullName = req.body?.full_name;
    const isValidName = fullName === undefined
        || fullName === null
        || typeof fullName === 'string';
    if (!isPlainObject(req.body) || !isValidName) {
        sendError(res, 400, 'Body must be an object with an optional string full_name');
        return;
    }

    let user = req.user;
    if (fullName !== undefined) {
        user = context.store.setUserName(user.email, normaliseName(fullName));
    }
    res.json(toUserResponse(user, context.config.adminEmails));
}

function logout(context, req, res) {
    if (context.config.authMode === 'cloudflare') {
        res.json({ logout_url: CLOUDFLARE_LOGOUT_URL });
        return;
    }

    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ logout_url: null });
}

/** context = { config, store, authenticator }; mounted at /api/auth. */
export function createAuthApiRouter(context) {
    const router = express.Router();
    const requireUser = createRequireUser(context);

    router.get('/me', requireUser, (req, res) => {
        res.json(toUserResponse(req.user, context.config.adminEmails));
    });
    router.put('/me', requireUser, (req, res) => updateMe(context, req, res));
    // Logout works without a valid session so a stale cookie can always be cleared.
    router.post('/logout', (req, res) => logout(context, req, res));

    return router;
}

// --- /login --------------------------------------------------------------

function sendHtml(res, status, html) {
    res.status(status).set('Cache-Control', 'no-store').type('html').send(html);
}

async function showLogin(context, req, res) {
    const fromUrl = typeof req.query.from_url === 'string' ? req.query.from_url : '';

    if (context.config.authMode === 'cloudflare') {
        const identity = await context.authenticator.authenticate(req.headers);
        if (identity) {
            res.redirect(303, safeRedirectTarget(fromUrl, requestOrigin(req)));
            return;
        }
        sendHtml(res, 200, renderCloudflareInfoPage());
        return;
    }

    sendHtml(res, 200, renderDevLoginPage({ fromUrl }));
}

function submitDevLogin(context, req, res) {
    const body = req.body || {};
    const fromUrl = typeof body.from_url === 'string' ? body.from_url : '';
    const email = normaliseEmail(body.email);
    const fullName = normaliseName(body.full_name);

    if (!email) {
        const page = renderDevLoginPage({
            fromUrl,
            email: typeof body.email === 'string' ? body.email : '',
            fullName: fullName || '',
            error: 'Please enter a valid email address.',
        });
        sendHtml(res, 400, page);
        return;
    }

    const user = context.store.upsertUser(email, fullName);
    const token = createSessionToken(context.config.sessionSecret, { email, full_name: user.full_name });
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions(req.secure));
    res.redirect(303, safeRedirectTarget(fromUrl, requestOrigin(req)));
}

/** context = { config, store, authenticator }; mounted at the app root. */
export function createLoginRouter(context) {
    const router = express.Router();

    router.get('/login', (req, res) => showLogin(context, req, res));

    if (context.config.authMode === 'dev') {
        router.post(
            '/login',
            express.urlencoded({ extended: false, limit: '16kb' }),
            (req, res) => submitDevLogin(context, req, res),
        );
    }

    return router;
}
