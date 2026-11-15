import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import express from 'express';
import { AuthController } from '../../src/http/controllers/AuthController.js';
import { SESSION_COOKIE } from '../../src/services/auth.js';
import { serveApp, signedInAs } from './httpHarness.js';

// AuthController over a fake UserService and authenticator, in both AUTH_MODEs: the /api/auth
// routes and the /login page. api.test.js and cloudflare.test.js cover the real services.

const USER = { email: 'ann@example.com', full_name: 'Ann' };

/** A fake UserService that records rename and startDevSession calls. */
function createFakeUsers() {
    const fake = {
        calls: [],
        toResponse: (user) => ({ shaped: user.email, full_name: user.full_name }),
        rename(user, fullName) {
            fake.calls.push(['rename', user, fullName]);
            return { ...user, full_name: fullName };
        },
        startDevSession(email, fullName) {
            fake.calls.push(['startDevSession', email, fullName]);
            return 'token123';
        },
    };
    return fake;
}

/** Serves the controller's /api/auth router and /login page, signed in as USER on /api/auth/me. */
function serveController(controller) {
    return serveApp((app) => {
        app.use('/api', express.json());
        app.use('/api/auth', controller.router());
        app.use(controller.loginRouter());
    });
}

describe('AuthController in dev mode', () => {
    let users;
    let harness;

    before(async () => {
        users = createFakeUsers();
        const controller = new AuthController({
            users,
            authenticator: { authenticate: async () => null },
            requireUser: signedInAs(USER),
            authMode: 'dev',
        });
        harness = await serveController(controller);
    });

    beforeEach(() => {
        users.calls = [];
    });

    after(async () => {
        await harness.close();
    });

    test('GET /me answers the signed-in user in API shape', async () => {
        const response = await harness.request('GET', '/api/auth/me');

        assert.equal(response.status, 200);
        assert.deepEqual(response.body, { shaped: USER.email, full_name: 'Ann' });
    });

    test('PUT /me renames the user with the name as sent', async () => {
        const response = await harness.request('PUT', '/api/auth/me', { body: { full_name: '  Annie ' } });

        assert.equal(response.status, 200);
        assert.deepEqual(users.calls, [['rename', USER, '  Annie ']]);
        assert.deepEqual(response.body, { shaped: USER.email, full_name: '  Annie ' });
    });

    test('PUT /me without full_name passes undefined, so the name is kept', async () => {
        await harness.request('PUT', '/api/auth/me', { body: {} });

        assert.deepEqual(users.calls, [['rename', USER, undefined]]);
    });

    test('PUT /me refuses a non-object body or a non-string name', async () => {
        for (const body of [[], { full_name: 5 }]) {
            const response = await harness.request('PUT', '/api/auth/me', { body });

            assert.equal(response.status, 400);
            assert.deepEqual(response.body, { message: 'Body must be an object with an optional string full_name' });
        }
        assert.deepEqual(users.calls, []);
    });

    test('logout clears the session cookie', async () => {
        const response = await harness.request('POST', '/api/auth/logout');

        assert.equal(response.status, 200);
        assert.deepEqual(response.body, { logout_url: null });
        assert.match(response.headers.get('set-cookie'), new RegExp(`^${SESSION_COOKIE}=;`));
    });

    test('GET /login shows the form, never cached', async () => {
        const response = await harness.request('GET', '/login?from_url=/room/abc');

        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.match(response.headers.get('content-type'), /text\/html/);
        assert.match(response.text, /\/room\/abc/);
    });

    test('a valid form starts a session and redirects to a same-origin from_url', async () => {
        const form = 'email=Ann%40Example.com&full_name=%20Ann%20&from_url=%2Froom%2Fabc';
        const response = await harness.request('POST', '/login', {
            body: form,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });

        assert.equal(response.status, 303);
        assert.equal(response.headers.get('location'), '/room/abc');
        assert.match(response.headers.get('set-cookie'), new RegExp(`^${SESSION_COOKIE}=token123;`));
        assert.deepEqual(users.calls, [['startDevSession', 'ann@example.com', 'Ann']]);
    });

    test('an off-site from_url redirects home', async () => {
        const response = await harness.request('POST', '/login', {
            body: 'email=ann%40example.com&from_url=https%3A%2F%2Fevil.com%2F',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });

        assert.equal(response.headers.get('location'), '/');
    });

    test('an invalid email shows the form again with a 400 and starts no session', async () => {
        const response = await harness.request('POST', '/login', {
            body: 'email=nope&full_name=Ann',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });

        assert.equal(response.status, 400);
        assert.match(response.text, /Please enter a valid email address\./);
        assert.match(response.text, /value="nope"/);
        assert.deepEqual(users.calls, []);
    });

    test('a form post without a form body is an invalid email', async () => {
        const response = await harness.request('POST', '/login');

        assert.equal(response.status, 400);
        assert.deepEqual(users.calls, []);
    });
});

describe('AuthController in cloudflare mode', () => {
    let identity;
    let harness;

    before(async () => {
        const controller = new AuthController({
            users: createFakeUsers(),
            authenticator: { authenticate: async () => identity },
            requireUser: signedInAs(USER),
            authMode: 'cloudflare',
        });
        harness = await serveController(controller);
    });

    after(async () => {
        await harness.close();
    });

    test('logout points at the Cloudflare Access logout', async () => {
        const response = await harness.request('POST', '/api/auth/logout');

        assert.deepEqual(response.body, { logout_url: '/cdn-cgi/access/logout' });
        assert.equal(response.headers.get('set-cookie'), null);
    });

    test('GET /login sends a signed-in visitor back to from_url', async () => {
        identity = { email: 'ann@example.com' };

        const response = await harness.request('GET', '/login?from_url=/room/abc');

        assert.equal(response.status, 303);
        assert.equal(response.headers.get('location'), '/room/abc');
    });

    test('GET /login shows the info page to anyone else', async () => {
        identity = null;

        const response = await harness.request('GET', '/login');

        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
    });

    test('there is no form to post to', async () => {
        const response = await harness.request('POST', '/login', { body: 'email=a%40b.com' });

        assert.equal(response.status, 404);
    });
});
