import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { api, attemptUpgrade, connectRealtime, startTestServer } from './helpers.js';

const TEAM_DOMAIN = 'flip7-test.cloudflareaccess.com';
const AUDIENCE = 'test-audience-tag';

describe('cloudflare mode', () => {
    let server;
    let privateKey;
    let otherPrivateKey;

    /** Signs an Access-style token; each option can be overridden to forge a bad one. */
    function signToken({ email = 'carol@example.com', issuer = `https://${TEAM_DOMAIN}`, audience = AUDIENCE, key = privateKey } = {}) {
        return new SignJWT({ email })
            .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
            .setIssuer(issuer)
            .setAudience(audience)
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(key);
    }

    before(async () => {
        const keyPair = await generateKeyPair('RS256');
        privateKey = keyPair.privateKey;
        otherPrivateKey = (await generateKeyPair('RS256')).privateKey;

        const publicJwk = await exportJWK(keyPair.publicKey);
        const keySet = createLocalJWKSet({ keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] });

        server = await startTestServer({
            env: {
                AUTH_MODE: 'cloudflare',
                CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
                CF_ACCESS_AUD: AUDIENCE,
            },
            keySet,
        });
    });

    after(async () => {
        await server.stop();
    });

    test('missing token returns 401', async () => {
        const response = await api(server.baseUrl, 'GET', '/api/auth/me');
        assert.equal(response.status, 401);
    });

    test('plain email header alone is not trusted', async () => {
        const response = await api(server.baseUrl, 'GET', '/api/auth/me', {
            headers: { 'cf-access-authenticated-user-email': 'carol@example.com' },
        });
        assert.equal(response.status, 401);
    });

    test('valid token in the header is accepted and upserts the user', async () => {
        const token = await signToken({ email: 'Carol@Example.com' });
        const response = await api(server.baseUrl, 'GET', '/api/auth/me', {
            headers: { 'cf-access-jwt-assertion': token },
        });
        assert.equal(response.status, 200);
        assert.equal(response.body.email, 'carol@example.com');
        assert.equal(response.body.role, 'user');
    });

    test('valid token in the CF_Authorization cookie is accepted', async () => {
        const token = await signToken();
        const response = await api(server.baseUrl, 'GET', '/api/entities/Player', { cookie: `CF_Authorization=${token}` });
        assert.equal(response.status, 200);
    });

    test('wrong audience, wrong issuer and wrong key are rejected', async () => {
        const badTokens = [
            await signToken({ audience: 'someone-else' }),
            await signToken({ issuer: 'https://evil.cloudflareaccess.com' }),
            await signToken({ key: otherPrivateKey }),
            'not-a-jwt',
        ];
        for (const token of badTokens) {
            const response = await api(server.baseUrl, 'GET', '/api/auth/me', {
                headers: { 'cf-access-jwt-assertion': token },
            });
            assert.equal(response.status, 401);
        }
    });

    test('logout returns the Access logout URL', async () => {
        const response = await api(server.baseUrl, 'POST', '/api/auth/logout');
        assert.deepEqual(response.body, { logout_url: '/cdn-cgi/access/logout' });
    });

    test('GET /login redirects when authenticated, otherwise shows the info page', async () => {
        const token = await signToken();
        const authenticated = await fetch(`${server.baseUrl}/login?from_url=%2Froom%2F1`, {
            redirect: 'manual',
            headers: { 'cf-access-jwt-assertion': token },
        });
        assert.equal(authenticated.status, 303);
        assert.equal(authenticated.headers.get('location'), '/room/1');

        const anonymous = await fetch(`${server.baseUrl}/login`);
        assert.equal(anonymous.status, 200);
        assert.match(await anonymous.text(), /Cloudflare/);
    });

    test('POST /login is not available', async () => {
        const response = await fetch(`${server.baseUrl}/login`, {
            method: 'POST',
            body: new URLSearchParams({ email: 'x@example.com' }),
        });
        assert.equal(response.status, 404);
    });

    test('WebSocket upgrade needs a valid token', async () => {
        assert.equal(await attemptUpgrade(server.wsUrl), 401);

        const token = await signToken();
        const client = connectRealtime(server.wsUrl, `CF_Authorization=${token}`);
        await client.opened;
        client.send({ type: 'hello', epoch: null, last_seq: null });
        assert.equal((await client.next()).type, 'ready');
        client.close();
    });
});
