// Tests for the backend client wiring. Run with `npm test`.
// The module reads browser globals when it loads, so they are stubbed before importing it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

class StubWebSocket {}

function stubBrowser(fetchImpl) {
    const fakeWindow = {
        location: { protocol: 'http:', host: 'test', href: 'http://test/' },
        WebSocket: StubWebSocket,
        fetch: { bind: () => fetchImpl },
        addEventListener: () => {},
    };
    globalThis.window = fakeWindow;
    globalThis.document = { addEventListener: () => {}, visibilityState: 'visible' };
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    globalThis.fetch = fetchImpl;
}

test('isAuthenticated on a 401 resolves false without signing realtime out; me() does sign out', async () => {
    const fetchImpl = async () => ({ status: 401, ok: false, text: async () => '{}' });
    stubBrowser(fetchImpl);
    const { backend, realtime } = await import('../src/api/backend.js');
    realtime.setStatus('live');

    assert.equal(await backend.auth.isAuthenticated(), false);
    assert.equal(realtime.getStatus(), 'live');

    await assert.rejects(backend.auth.me(), { status: 401 });
    assert.equal(realtime.getStatus(), 'signed-out');
});
