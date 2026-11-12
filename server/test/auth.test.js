import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { before, describe, test } from 'node:test';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import {
    CF_JWT_COOKIE,
    CF_JWT_HEADER,
    MAX_NAME_LENGTH,
    SESSION_COOKIE,
    createAuthenticator,
    createSessionToken,
    normaliseEmail,
    normaliseName,
    parseCookies,
    sessionCookieOptions,
    verifySessionToken,
} from '../src/auth.js';

const SECRET = 'test-secret';

/** Builds a correctly signed token around an arbitrary payload part. */
function signedToken(payloadPart, secret = SECRET) {
    const signature = crypto.createHmac('sha256', secret).update(payloadPart).digest('base64url');
    return `${payloadPart}.${signature}`;
}

function signedPayload(payload) {
    return signedToken(Buffer.from(JSON.stringify(payload)).toString('base64url'));
}

// --- parseCookies -------------------------------------------------------

describe('parseCookies', () => {
    test('no header gives an empty map', () => {
        assert.equal(parseCookies(undefined).size, 0);
        assert.equal(parseCookies('').size, 0);
    });

    test('parses several cookies and trims whitespace', () => {
        const cookies = parseCookies(' a=1;b = 2 ;  c=3');
        assert.deepEqual([...cookies], [['a', '1'], ['b', '2'], ['c', '3']]);
    });

    test('the last of duplicate names wins', () => {
        assert.equal(parseCookies('a=1; a=2').get('a'), '2');
    });

    test('an = inside a value is kept', () => {
        assert.equal(parseCookies('token=abc=def==').get('token'), 'abc=def==');
    });

    test('malformed encoding is skipped without throwing', () => {
        const cookies = parseCookies('bad=%E0%A4%A; good=hello%20world; novalue');
        assert.equal(cookies.has('bad'), false);
        assert.equal(cookies.has('novalue'), false);
        assert.equal(cookies.get('good'), 'hello world');
    });
});

// --- verifySessionToken -------------------------------------------------

describe('verifySessionToken', () => {
    test('round-trips a valid identity', () => {
        const token = createSessionToken(SECRET, { email: 'Ann@Example.com', full_name: ' Ann ' });
        assert.deepEqual(verifySessionToken(SECRET, token), { email: 'ann@example.com', full_name: 'Ann' });
    });

    test('a missing name becomes null', () => {
        const token = createSessionToken(SECRET, { email: 'ann@example.com' });
        assert.equal(verifySessionToken(SECRET, token).full_name, null);
    });

    test('rejects a wrong signature or secret', () => {
        const token = createSessionToken(SECRET, { email: 'ann@example.com' });
        assert.equal(verifySessionToken('other-secret', token), null);

        const [payloadPart] = token.split('.');
        assert.equal(verifySessionToken(SECRET, `${payloadPart}.${'A'.repeat(43)}`), null);
    });

    test('rejects truncated and malformed tokens', () => {
        const token = createSessionToken(SECRET, { email: 'ann@example.com' });
        assert.equal(verifySessionToken(SECRET, token.slice(0, -5)), null);
        assert.equal(verifySessionToken(SECRET, token.split('.')[0]), null);
        assert.equal(verifySessionToken(SECRET, `${token}.extra`), null);
        assert.equal(verifySessionToken(SECRET, '.sig'), null);
        assert.equal(verifySessionToken(SECRET, ''), null);
        assert.equal(verifySessionToken(SECRET, undefined), null);
        assert.equal(verifySessionToken(SECRET, 42), null);
    });

    test('rejects a correctly signed token with bad base64 or bad JSON', () => {
        assert.equal(verifySessionToken(SECRET, signedToken('!!!not-base64!!!')), null);
        assert.equal(verifySessionToken(SECRET, signedToken(Buffer.from('{oops').toString('base64url'))), null);
    });

    test('rejects a payload with a bad email or no issue time', () => {
        assert.equal(verifySessionToken(SECRET, signedPayload({ email: 'nope', issued_at: Date.now() })), null);
        assert.equal(verifySessionToken(SECRET, signedPayload({ email: 'a@b.c' })), null);
        assert.equal(verifySessionToken(SECRET, signedPayload({ email: 'a@b.c', issued_at: 'now' })), null);
        assert.equal(verifySessionToken(SECRET, signedPayload(null)), null);
    });

    test('rejects an expired token (older than 30 days)', () => {
        const thirtyOneDays = 31 * 24 * 60 * 60 * 1000;
        const old = signedPayload({ email: 'a@b.c', issued_at: Date.now() - thirtyOneDays });
        assert.equal(verifySessionToken(SECRET, old), null);
    });
});

// --- Normalisers --------------------------------------------------------

describe('normaliseEmail', () => {
    test('lower-cases and trims', () => {
        assert.equal(normaliseEmail('  Bob@Example.COM '), 'bob@example.com');
    });

    test('rejects invalid shapes and non-strings', () => {
        for (const value of ['', 'bob', '@x.com', 'bob@', 'a b@c.com', 'a@@b.com', null, undefined, 5, {}]) {
            assert.equal(normaliseEmail(value), null, String(value));
        }
    });

    test('rejects emails over 254 characters', () => {
        assert.equal(normaliseEmail(`${'a'.repeat(251)}@b.c`), null);
        assert.notEqual(normaliseEmail(`${'a'.repeat(250)}@b.c`), null);
    });
});

describe('normaliseName', () => {
    test('trims and keeps case', () => {
        assert.equal(normaliseName('  Ann Lee '), 'Ann Lee');
    });

    test('caps at the 100-character limit', () => {
        assert.equal(normaliseName('x'.repeat(150)).length, MAX_NAME_LENGTH);
        assert.equal(MAX_NAME_LENGTH, 100);
    });

    test('blank and non-string input gives null', () => {
        for (const value of ['', '   ', null, undefined, 7, []]) {
            assert.equal(normaliseName(value), null, String(value));
        }
    });
});

// --- sessionCookieOptions -----------------------------------------------

test('sessionCookieOptions sets secure only over HTTPS', () => {
    assert.equal(sessionCookieOptions(true).secure, true);
    assert.equal(sessionCookieOptions(false).secure, false);
    assert.equal(sessionCookieOptions(false).httpOnly, true);
    assert.equal(sessionCookieOptions(false).sameSite, 'lax');
});

// --- createAuthenticator ------------------------------------------------

const TEAM_DOMAIN = 'team.example.com';
const AUDIENCE = 'aud-tag';

function makeLogger() {
    const warnings = [];
    return { warnings, warn: (message) => warnings.push(message) };
}

describe('createAuthenticator (dev)', () => {
    test('reads the session cookie and ignores bad ones', async () => {
        const authenticator = createAuthenticator({ authMode: 'dev', sessionSecret: SECRET });
        const token = createSessionToken(SECRET, { email: 'ann@example.com' });

        assert.equal(authenticator.mode, 'dev');
        assert.equal((await authenticator.authenticate({ cookie: `${SESSION_COOKIE}=${token}` })).email, 'ann@example.com');
        assert.equal(await authenticator.authenticate({}), null);
        assert.equal(await authenticator.authenticate({ cookie: `${SESSION_COOKIE}=garbage` }), null);
    });
});

describe('createAuthenticator (cloudflare)', () => {
    const config = { authMode: 'cloudflare', cfTeamDomain: TEAM_DOMAIN, cfAudience: AUDIENCE };
    let privateKey;
    let authenticator;
    let logger;

    function sign(claims, { issuer = `https://${TEAM_DOMAIN}`, audience = AUDIENCE } = {}) {
        return new SignJWT(claims)
            .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
            .setIssuer(issuer)
            .setAudience(audience)
            .setExpirationTime('5m')
            .sign(privateKey);
    }

    before(async () => {
        const keyPair = await generateKeyPair('RS256');
        privateKey = keyPair.privateKey;
        const jwk = { ...(await exportJWK(keyPair.publicKey)), kid: 'k1', alg: 'RS256' };
        logger = makeLogger();
        authenticator = createAuthenticator(config, { keySet: createLocalJWKSet({ keys: [jwk] }), logger });
    });

    test('accepts a valid token from the header or the cookie', async () => {
        const token = await sign({ email: 'Carol@Example.com', name: 'Carol' });

        const fromHeader = await authenticator.authenticate({ [CF_JWT_HEADER]: token });
        const fromCookie = await authenticator.authenticate({ cookie: `${CF_JWT_COOKIE}=${token}` });

        assert.equal(authenticator.mode, 'cloudflare');
        assert.deepEqual(fromHeader, { email: 'carol@example.com', full_name: 'Carol' });
        assert.deepEqual(fromCookie, fromHeader);
    });

    test('no token gives null', async () => {
        assert.equal(await authenticator.authenticate({}), null);
        assert.equal(await authenticator.authenticate({ [CF_JWT_HEADER]: '' }), null);
    });

    test('rejects wrong audience, wrong issuer and a token without a valid email, logging a warning', async () => {
        const before = logger.warnings.length;
        const wrongAudience = await sign({ email: 'a@b.c' }, { audience: 'other' });
        const wrongIssuer = await sign({ email: 'a@b.c' }, { issuer: 'https://evil.example.com' });
        const noEmail = await sign({ name: 'x' });

        assert.equal(await authenticator.authenticate({ [CF_JWT_HEADER]: wrongAudience }), null);
        assert.equal(await authenticator.authenticate({ [CF_JWT_HEADER]: wrongIssuer }), null);
        assert.equal(await authenticator.authenticate({ [CF_JWT_HEADER]: noEmail }), null);
        assert.equal(await authenticator.authenticate({ [CF_JWT_HEADER]: 'not.a.jwt' }), null);
        assert.equal(logger.warnings.length - before, 3);
    });

    test('builds a remote key set when none is injected', () => {
        const remote = createAuthenticator(config, { logger });
        assert.equal(remote.mode, 'cloudflare');
    });
});
