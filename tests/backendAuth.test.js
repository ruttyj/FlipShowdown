// Tests for the backend auth helpers and entity forwarding. Run with `npm test`.
// The module reads browser globals when it loads, so they are stubbed before importing it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

class StubWebSocket {}

function jsonResponse(status, body) {
    return {
        status,
        ok: status >= 200 && status < 300,
        text: async () => JSON.stringify(body),
    };
}

let currentResponse = jsonResponse(200, {});
const requests = [];

async function fetchImpl(url, init) {
    requests.push({ url, init });
    return currentResponse;
}

const fakeWindow = {
    location: {
        protocol: 'http:',
        host: 'test',
        href: 'http://test/',
        reload: () => {
            fakeWindow.reloaded = true;
        },
    },
    WebSocket: StubWebSocket,
    fetch: { bind: () => fetchImpl },
    addEventListener: () => {},
    reloaded: false,
};
globalThis.window = fakeWindow;
globalThis.document = { addEventListener: () => {}, visibilityState: 'visible' };
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
globalThis.fetch = fetchImpl;

const { backend } = await import('../src/api/backend.js');

function respondWith(status, body) {
    requests.length = 0;
    currentResponse = jsonResponse(status, body);
    fakeWindow.location.href = 'http://test/';
    fakeWindow.reloaded = false;
}

test('updateMe sends a PUT with the data and resolves the response', async () => {
    respondWith(200, { id: 'u1', full_name: 'Ann' });

    const result = await backend.auth.updateMe({ full_name: 'Ann' });

    assert.deepEqual(result, { id: 'u1', full_name: 'Ann' });
    assert.equal(requests[0].url, '/api/auth/me');
    assert.equal(requests[0].init.method, 'PUT');
    assert.equal(requests[0].init.body, JSON.stringify({ full_name: 'Ann' }));
});

test('logout in dev (logout_url null) with no redirect reloads the page', async () => {
    respondWith(200, { logout_url: null });

    await backend.auth.logout();

    assert.equal(requests[0].init.method, 'POST');
    assert.equal(requests[0].url, '/api/auth/logout');
    assert.equal(fakeWindow.reloaded, true);
    assert.equal(fakeWindow.location.href, 'http://test/');
});

test('logout in dev goes to the given redirect URL', async () => {
    respondWith(200, { logout_url: null });

    await backend.auth.logout('/goodbye');

    assert.equal(fakeWindow.location.href, '/goodbye');
    assert.equal(fakeWindow.reloaded, false);
});

test('logout in cloudflare mode navigates to the server logout URL', async () => {
    respondWith(200, { logout_url: 'https://team.cloudflareaccess.com/logout' });

    await backend.auth.logout('/ignored');

    assert.equal(fakeWindow.location.href, 'https://team.cloudflareaccess.com/logout');
});

test('logout still leaves when the request fails', async () => {
    respondWith(500, { message: 'down' });
    const originalError = console.error;
    console.error = () => {};

    try {
        await backend.auth.logout('/bye');
    } finally {
        console.error = originalError;
    }

    assert.equal(fakeWindow.location.href, '/bye');
});

test('redirectToLogin encodes the target URL', () => {
    respondWith(200, {});

    backend.auth.redirectToLogin('http://test/room?id=a b&x=1');

    assert.equal(
        fakeWindow.location.href,
        `/login?from_url=${encodeURIComponent('http://test/room?id=a b&x=1')}`,
    );
});

test('redirectToLogin without a URL uses the current page', () => {
    respondWith(200, {});

    backend.auth.redirectToLogin();

    assert.equal(fakeWindow.location.href, `/login?from_url=${encodeURIComponent('http://test/')}`);
});

test('entity proxies forward to the entities API', async () => {
    respondWith(200, { id: 'p1' });

    await backend.entities.Player.create({ name: 'Bo' });
    await backend.entities.Player.get('p1');

    assert.equal(requests[0].init.method, 'POST');
    assert.equal(requests[0].init.body, JSON.stringify({ name: 'Bo' }));
    assert.equal(requests[1].init.method, 'GET');
    assert.match(requests[1].url, /\/p1$/);
});

test('isAuthenticated is true when /api/auth/me answers', async () => {
    respondWith(200, { id: 'u1' });

    assert.equal(await backend.auth.isAuthenticated(), true);
});
