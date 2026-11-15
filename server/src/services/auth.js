import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { normaliseEmail } from '../lib/email.js';

// Lives in lib/email.js; re-exported for email.test, which checks auth.js uses the same function.
export { normaliseEmail };

export const SESSION_COOKIE = 'flip7_session';
export const CF_JWT_HEADER = 'cf-access-jwt-assertion';
export const CF_JWT_COOKIE = 'CF_Authorization';

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_NAME_LENGTH = 100;

// --- Cookies -------------------------------------------------------------

/** Parses a Cookie header ("a=1; b=2") into a plain map. Malformed parts are skipped. */
export function parseCookies(header) {
    const cookies = new Map();
    if (!header) {
        return cookies;
    }

    for (const part of header.split(';')) {
        const separator = part.indexOf('=');
        if (separator === -1) {
            continue;
        }

        const name = part.slice(0, separator).trim();
        const rawValue = part.slice(separator + 1).trim();
        try {
            cookies.set(name, decodeURIComponent(rawValue));
        } catch {
            // A bad %-escape in someone else's cookie shouldn't break auth.
            continue;
        }
    }
    return cookies;
}

// --- Identity validation -------------------------------------------------

/** Trimmed display name capped at MAX_NAME_LENGTH, or null when empty. */
export function normaliseName(value) {
    if (typeof value !== 'string') {
        return null;
    }

    const name = value.trim().slice(0, MAX_NAME_LENGTH);
    if (name === '') {
        return null;
    }
    return name;
}

// --- Dev session cookie --------------------------------------------------
// Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload part)).

function sign(secret, payloadPart) {
    return crypto.createHmac('sha256', secret).update(payloadPart).digest('base64url');
}

export function createSessionToken(secret, identity) {
    const payload = {
        email: identity.email,
        full_name: identity.full_name || null,
        issued_at: Date.now(),
    };
    const payloadPart = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${payloadPart}.${sign(secret, payloadPart)}`;
}

/** Returns { email, full_name } for a valid, unexpired token, otherwise null. */
export function verifySessionToken(secret, token) {
    if (typeof token !== 'string') {
        return null;
    }

    const [payloadPart, signaturePart, ...rest] = token.split('.');
    if (!payloadPart || !signaturePart || rest.length > 0) {
        return null;
    }

    const expected = Buffer.from(sign(secret, payloadPart));
    const actual = Buffer.from(signaturePart);
    // timingSafeEqual throws on length mismatch, so check that first.
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        return null;
    }

    let payload;
    try {
        payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    } catch {
        return null;
    }

    const email = normaliseEmail(payload?.email);
    const isExpired = typeof payload?.issued_at !== 'number' || Date.now() - payload.issued_at > SESSION_MAX_AGE_MS;
    if (!email || isExpired) {
        return null;
    }
    return { email, full_name: normaliseName(payload.full_name) };
}

export function sessionCookieOptions(isSecure) {
    return {
        httpOnly: true,
        sameSite: 'lax',
        secure: isSecure,
        path: '/',
        maxAge: SESSION_MAX_AGE_MS,
    };
}

// --- Cloudflare Access ---------------------------------------------------

function readCloudflareToken(headers, cookies) {
    const headerToken = headers[CF_JWT_HEADER];
    if (typeof headerToken === 'string' && headerToken !== '') {
        return headerToken;
    }
    return cookies.get(CF_JWT_COOKIE) || null;
}

// --- Authenticators ------------------------------------------------------
// Each has `mode` ('dev' or 'cloudflare') and `authenticate(headers)`, which works on raw Node
// headers so it serves both Express requests and WebSocket upgrades. It resolves to
// { email, full_name } or null.

/** AUTH_MODE=dev: the signed session cookie the dev login sets, checked with `sessionSecret`. */
export class DevSessionAuthenticator {
    #sessionSecret;

    constructor({ sessionSecret }) {
        this.mode = 'dev';
        this.#sessionSecret = sessionSecret;
    }

    async authenticate(headers) {
        const cookies = parseCookies(headers.cookie);
        return verifySessionToken(this.#sessionSecret, cookies.get(SESSION_COOKIE));
    }
}

/**
 * AUTH_MODE=cloudflare: the Cloudflare Access JWT for team domain `teamDomain` and application
 * `audience`. `keySet` replaces the remote Cloudflare JWKS (tests); a rejected token is logged
 * as a warning on `logger`.
 */
export class CloudflareAuthenticator {
    #keySet;
    #issuer;
    #audience;
    #logger;

    constructor({ teamDomain, audience, keySet, logger }) {
        this.mode = 'cloudflare';
        // Created once: jose caches the fetched keys inside this object and
        // refreshes them when it sees an unknown key id.
        this.#keySet = keySet || createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
        this.#issuer = `https://${teamDomain}`;
        this.#audience = audience;
        this.#logger = logger;
    }

    async authenticate(headers) {
        const token = readCloudflareToken(headers, parseCookies(headers.cookie));
        if (!token) {
            return null;
        }
        return this.#verify(token);
    }

    async #verify(token) {
        try {
            const { payload } = await jwtVerify(token, this.#keySet, {
                issuer: this.#issuer,
                audience: this.#audience,
            });
            const email = normaliseEmail(payload.email);
            if (!email) {
                return null;
            }
            return { email, full_name: normaliseName(payload.name) };
        } catch (error) {
            this.#logger.warn(`Rejected Cloudflare Access token: ${error.code || error.message}`);
            return null;
        }
    }
}

/**
 * The authenticator for the configured AUTH_MODE (`config` is loadConfig()'s result). AuthProvider
 * builds the server's through it, and auth.test calls it directly. `options.keySet` replaces the
 * remote Cloudflare JWKS (tests) and `options.logger` defaults to console.
 */
export function createAuthenticator(config, options = {}) {
    if (config.authMode === 'dev') {
        return new DevSessionAuthenticator({ sessionSecret: config.sessionSecret });
    }

    return new CloudflareAuthenticator({
        teamDomain: config.cfTeamDomain,
        audience: config.cfAudience,
        keySet: options.keySet,
        logger: options.logger || console,
    });
}
