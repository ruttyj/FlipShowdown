// Tests for httpClient, game.js and runAction. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../src/api/httpClient.js';
import { RealtimeConnection } from '../src/api/realtime.js';
import { runAction } from '../src/lib/runAction.js';

// --- Test doubles ------------------------------------------------------------

function jsonResponse(status, body = {}) {
    return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) };
}

/** A fetch that answers with each queued item in turn; Error items are thrown. */
function queuedFetch(items) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        const item = items.shift();
        if (item instanceof Error) {
            throw item;
        }
        return item;
    };
    return { fetchImpl, calls };
}

function makeClient(items) {
    const { fetchImpl, calls } = queuedFetch(items);
    const sleeps = [];
    const sleep = async (ms) => {
        sleeps.push(ms);
    };
    return { client: createHttpClient({ fetchImpl, sleep }), calls, sleeps };
}

// --- Signed-out detection ----------------------------------------------------

test('401 rejects with status 401 and notifies listeners', async () => {
    const { client, calls } = makeClient([jsonResponse(401, { message: 'no' })]);
    let fired = 0;
    client.onSignedOut(() => {
        fired += 1;
    });

    await assert.rejects(client.request('GET', '/api/x'), { status: 401 });
    assert.equal(fired, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.redirect, 'manual');
});

test('opaqueredirect counts as signed out, and unsubscribe works', async () => {
    const redirect = { status: 0, ok: false, type: 'opaqueredirect', text: async () => '' };
    const { client } = makeClient([redirect, redirect]);
    let fired = 0;
    const off = client.onSignedOut(() => {
        fired += 1;
    });

    await assert.rejects(client.request('POST', '/api/x'), { status: 401 });
    off();
    await assert.rejects(client.request('POST', '/api/x'), { status: 401 });
    assert.equal(fired, 1);
});

test('signed-out makes realtime report signed-out', async () => {
    const { client } = makeClient([jsonResponse(401)]);
    const realtime = new RealtimeConnection({ url: 'ws://x', WebSocketImpl: class {} });
    client.onSignedOut(() => realtime.signOut());
    const statuses = [];
    realtime.onStatus((status) => statuses.push(status));

    await assert.rejects(client.request('GET', '/api/x'));
    assert.equal(realtime.getStatus(), 'signed-out');
    assert.deepEqual(statuses, ['signed-out']);
});

// --- Retries -----------------------------------------------------------------

test('GET retries network errors and 5xx, then succeeds', async () => {
    const { client, calls, sleeps } = makeClient([
        new TypeError('network'),
        jsonResponse(503),
        jsonResponse(200, { ok: 1 }),
    ]);
    assert.deepEqual(await client.request('GET', '/api/x'), { ok: 1 });
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [300, 600]);
});

test('GET gives up after 3 retries with the last error shape', async () => {
    const { client, calls } = makeClient([
        jsonResponse(500),
        jsonResponse(500),
        jsonResponse(500),
        jsonResponse(502, { message: 'bad gateway' }),
    ]);
    await assert.rejects(client.request('GET', '/api/x'), { status: 502, message: 'bad gateway' });
    assert.equal(calls.length, 4);
});

test('GET does not retry 4xx', async () => {
    const { client, calls } = makeClient([jsonResponse(404, { message: 'nope' })]);
    await assert.rejects(client.request('GET', '/api/x'), { status: 404 });
    assert.equal(calls.length, 1);
});

test('POST, PUT and DELETE never retry', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
        const failing = makeClient([jsonResponse(500), jsonResponse(200)]);
        await assert.rejects(failing.client.request(method, '/api/x', { body: {} }), { status: 500 });
        assert.equal(failing.calls.length, 1, method);

        const offline = makeClient([new TypeError('network'), jsonResponse(200)]);
        await assert.rejects(offline.client.request(method, '/api/x'), TypeError);
        assert.equal(offline.calls.length, 1, method);
    }
});

// --- game.js -----------------------------------------------------------------

test('each game function sends the right method, path and body', async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        const body = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ url, method: init.method, body });
        return jsonResponse(200, { room: {}, players: [] });
    };
    const { game } = await import('../src/api/game.js');

    const score = { round_number: 2, cards: [], base_sum: 5, final_score: 7 };
    const table = [
        [() => game.createRoom({ max_score: 200, name: 'A' }), 'POST', '/api/rooms', { max_score: 200, name: 'A' }],
        [
            () => game.createRoom({ max_score: 200, game_mode: 'vengeance' }),
            'POST',
            '/api/rooms',
            { max_score: 200, game_mode: 'vengeance' },
        ],
        [() => game.lookupRoom('AB12'), 'GET', '/api/rooms/by-code/AB12', undefined],
        [() => game.join('r1', { name: 'A' }), 'POST', '/api/rooms/r1/actions/join', { name: 'A' }],
        [() => game.leave('r1'), 'POST', '/api/rooms/r1/actions/leave', {}],
        [() => game.kick('r1', 'p1'), 'POST', '/api/rooms/r1/actions/kick', { player_id: 'p1' }],
        [() => game.makeHost('r1', 'p1'), 'POST', '/api/rooms/r1/actions/make-host', { player_id: 'p1' }],
        [() => game.reorder('r1', ['a', 'b']), 'POST', '/api/rooms/r1/actions/reorder', { player_ids: ['a', 'b'] }],
        [() => game.setGameMode('r1', 'vengeance'), 'POST', '/api/rooms/r1/actions/set-game-mode', { game_mode: 'vengeance' }],
        [() => game.start('r1'), 'POST', '/api/rooms/r1/actions/start', {}],
        [() => game.submitScore('r1', score), 'POST', '/api/rooms/r1/actions/submit-score', score],
        [
            () => game.submitScore('r1', { ...score, flip7_attack_player_id: 'p2' }),
            'POST',
            '/api/rooms/r1/actions/submit-score',
            { ...score, flip7_attack_player_id: 'p2' },
        ],
        [
            () => game.editScore('r1', { player_id: 'p1', ...score, flip7_attack_player_id: 'p2' }),
            'POST',
            '/api/rooms/r1/actions/edit-score',
            { player_id: 'p1', ...score, flip7_attack_player_id: 'p2' },
        ],
        [
            () => game.submitScore('r1', { ...score, game_mode: 'vengeance' }),
            'POST',
            '/api/rooms/r1/actions/submit-score',
            { ...score, game_mode: 'vengeance' },
        ],
        [
            () => game.submitScore('r1', { ...score, busted: true, duplicate_allowed: true }),
            'POST',
            '/api/rooms/r1/actions/submit-score',
            { ...score, busted: true, duplicate_allowed: true },
        ],
        [() => game.retractScore('r1', 3), 'POST', '/api/rooms/r1/actions/retract-score', { round_number: 3 }],
        [() => game.reopenGame('r1'), 'POST', '/api/rooms/r1/actions/reopen-game', {}],
        [
            () => game.editScore('r1', { player_id: 'p1', ...score, busted: true, duplicate_allowed: true }),
            'POST',
            '/api/rooms/r1/actions/edit-score',
            { player_id: 'p1', ...score, busted: true, duplicate_allowed: true },
        ],
        [() => game.forceNextRound('r1', 3), 'POST', '/api/rooms/r1/actions/force-next-round', { round_number: 3 }],
        [() => game.setEditMode('r1', true), 'POST', '/api/rooms/r1/actions/set-edit-mode', { on: true }],
        [
            () => game.editScore('r1', { player_id: 'p1', ...score }),
            'POST',
            '/api/rooms/r1/actions/edit-score',
            { player_id: 'p1', ...score },
        ],
        [
            () => game.editScore('r1', { player_id: 'p1', ...score, game_mode: 'vengeance' }),
            'POST',
            '/api/rooms/r1/actions/edit-score',
            { player_id: 'p1', ...score, game_mode: 'vengeance' },
        ],
        [() => game.endGame('r1'), 'POST', '/api/rooms/r1/actions/end-game', {}],
        [() => game.playAgain('r1'), 'POST', '/api/rooms/r1/actions/play-again', {}],
        [() => game.setGamesWon('r1', { p1: 2 }), 'POST', '/api/rooms/r1/actions/set-games-won', { wins: { p1: 2 } }],
        [() => game.closeRoom('r1'), 'POST', '/api/rooms/r1/actions/close', {}],
        [() => game.deleteRoom('r1'), 'POST', '/api/rooms/r1/actions/delete', {}],
    ];

    try {
        for (const [run, method, url, body] of table) {
            await run();
            assert.deepEqual(calls.pop(), { url, method, body }, url);
        }
        assert.equal(calls.length, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// --- runAction ---------------------------------------------------------------

test('runAction toggles busy and returns the result', async () => {
    const busy = [];
    const result = await runAction('Save', async () => 42, { setBusy: (value) => busy.push(value) });
    assert.equal(result, 42);
    assert.deepEqual(busy, [true, false]);
});

test('runAction toasts failures and returns undefined', async () => {
    const busy = [];
    const toasts = [];
    const result = await runAction(
        'Start game',
        async () => {
            throw new Error('boom');
        },
        { setBusy: (value) => busy.push(value), showToast: (message) => toasts.push(message) },
    );

    assert.equal(result, undefined);
    assert.deepEqual(toasts, ['Start game failed: boom']);
    assert.deepEqual(busy, [true, false]);
});

test('runAction shows no toast for 401', async () => {
    const toasts = [];
    const error = Object.assign(new Error('Signed out'), { status: 401 });
    const result = await runAction(
        'Save',
        async () => {
            throw error;
        },
        { showToast: (message) => toasts.push(message) },
    );

    assert.equal(result, undefined);
    assert.deepEqual(toasts, []);
});

// --- Review fixes ------------------------------------------------------------------

test('401 with an unreadable body still notifies listeners and rejects with 401', async () => {
    const unreadable = {
        status: 401,
        ok: false,
        text: async () => {
            throw new Error('connection dropped');
        },
    };
    const { client } = makeClient([unreadable]);
    let fired = 0;
    client.onSignedOut(() => {
        fired += 1;
    });

    await assert.rejects(client.request('GET', '/api/x'), { status: 401 });
    assert.equal(fired, 1);
});

test('signedOutEvent: false rejects on 401 without notifying listeners', async () => {
    const { client } = makeClient([jsonResponse(401)]);
    let fired = 0;
    client.onSignedOut(() => {
        fired += 1;
    });

    await assert.rejects(client.request('GET', '/api/auth/me', { signedOutEvent: false }), { status: 401 });
    assert.equal(fired, 0);
});
