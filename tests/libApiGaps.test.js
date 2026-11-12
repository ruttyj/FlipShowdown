// Branch and line gaps in src/lib and src/api that the feature tests don't reach.
// Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../src/api/httpClient.js';
import { getAiConfig, scanCards } from '../src/api/ai.js';
import { createEntityClient } from '../src/api/entities.js';
import { queryClientInstance } from '../src/lib/query-client.js';
import { forgetLeftRoom } from '../src/lib/autoJoin.js';
import { errorCode, classifySubmitError } from '../src/lib/gameActionOutcomes.js';
import { createHookState, hookReducer } from '../src/lib/roomHookState.js';
import { fetchRoomSnapshot } from '../src/lib/roomLoader.js';
import {
    applyEvent,
    applyPresence,
    applySnapshot,
    createRoomState,
    markRoomGone,
    selectMyPlayer,
    selectSortedPlayers,
} from '../src/lib/roomState.js';
import { runAction } from '../src/lib/runAction.js';

// --- Helpers -----------------------------------------------------------------

function textResponse(status, text) {
    return { status, ok: status >= 200 && status < 300, text: async () => text };
}

function clientFor(response) {
    const fetchImpl = async () => response;
    return createHttpClient({ fetchImpl });
}

/** Runs `body` with globalThis.fetch replaced, always restoring it. */
async function withFetch(fetchStub, body) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchStub;
    try {
        await body();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

function makeRoom(overrides = {}) {
    return { id: 'room1', code: 'ABC234', status: 'playing', version: 1, ...overrides };
}

function makePlayer(id, overrides = {}) {
    return { id, room_id: 'room1', name: id, ...overrides };
}

function emptySnapshot(room) {
    return { room, players: [], roundScores: [], chatMessages: [] };
}

function loadedState() {
    return applySnapshot(createRoomState(), {
        room: makeRoom(),
        players: [makePlayer('p1'), makePlayer('p2')],
        roundScores: [],
        chatMessages: [],
        myPlayerId: 'p1',
    });
}

// --- api/httpClient ----------------------------------------------------------

test('an empty response body resolves null', async () => {
    const client = clientFor(textResponse(204, ''));

    assert.equal(await client.request('DELETE', '/api/x'), null);
});

test('a non-JSON body resolves as raw text', async () => {
    const client = clientFor(textResponse(200, 'plain words'));

    assert.equal(await client.request('POST', '/api/x'), 'plain words');
});

test('a throwing signed-out listener is logged and the others still run', async () => {
    const client = clientFor(textResponse(401, '{}'));
    const calls = [];
    client.onSignedOut(() => {
        throw new Error('boom');
    });
    client.onSignedOut(() => calls.push('second'));
    const originalError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args);

    try {
        await assert.rejects(client.request('POST', '/api/x'), { status: 401 });
    } finally {
        console.error = originalError;
    }

    assert.deepEqual(calls, ['second']);
    assert.equal(logged.length, 1);
});

test('the default client uses the global fetch and a real sleep between retries', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const answers = [textResponse(503, '{}'), textResponse(200, '{"ok":true}')];
    const delays = [];
    globalThis.setTimeout = (callback, delay) => {
        delays.push(delay);
        return originalSetTimeout(callback, 0);
    };

    try {
        await withFetch(async () => answers.shift(), async () => {
            const client = createHttpClient();
            assert.deepEqual(await client.request('GET', '/api/x'), { ok: true });
        });
    } finally {
        globalThis.setTimeout = originalSetTimeout;
    }

    assert.deepEqual(delays, [300]);
});

// --- api/ai, api/entities, lib/query-client ------------------------------------

test('ai calls go to the server AI endpoints', async () => {
    const calls = [];
    const stub = async (url, init) => {
        calls.push({ url, init });
        return textResponse(200, '{"enabled":true}');
    };

    await withFetch(stub, async () => {
        assert.deepEqual(await getAiConfig(), { enabled: true });
        await scanCards('data:image/png;base64,AA', 'model-x');
    });

    assert.equal(calls[0].url, '/api/ai/config');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[1].url, '/api/ai/scan-cards');
    assert.equal(calls[1].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[1].init.body), { image: 'data:image/png;base64,AA', model: 'model-x' });
});

test('a scan sends the mode it was asked for', async () => {
    const calls = [];
    const stub = async (url, init) => {
        calls.push({ url, init });
        return textResponse(200, '{}');
    };

    await withFetch(stub, async () => {
        await scanCards('data:image/png;base64,AA', 'model-x', 'vengeance');
    });

    assert.deepEqual(JSON.parse(calls[0].init.body), {
        image: 'data:image/png;base64,AA',
        model: 'model-x',
        mode: 'vengeance',
    });
});

test('entity filter with no query matches everything', async () => {
    const urls = [];
    const stub = async (url) => {
        urls.push(url);
        return textResponse(200, '[]');
    };

    await withFetch(stub, async () => {
        await createEntityClient('Player', {}).filter(undefined);
    });

    assert.equal(urls[0], `/api/entities/Player?q=${encodeURIComponent('{}')}`);
});

test('the shared query client does not refetch on focus and retries once', () => {
    const { queries } = queryClientInstance.getDefaultOptions();

    assert.equal(queries.refetchOnWindowFocus, false);
    assert.equal(queries.retry, 1);
});

// --- lib/autoJoin, gameActionOutcomes, runAction ----------------------------

test('forgetLeftRoom without a code does nothing', () => {
    assert.doesNotThrow(() => forgetLeftRoom(''));
});

test('errorCode is null without an error or a code', () => {
    assert.equal(errorCode(null), null);
    assert.equal(errorCode({ data: {} }), null);
    assert.equal(errorCode({ data: { code: 'x' } }), 'x');
});

test('classifySubmitError copes with a 409 that has no body', () => {
    assert.equal(classifySubmitError({ status: 409 }), null);
});

test('runAction reports a thrown value that has no message', async () => {
    const toasts = [];

    const result = await runAction('Save', () => Promise.reject(undefined), { showToast: (text) => toasts.push(text) });

    assert.equal(result, undefined);
    assert.deepEqual(toasts, ['Save failed: unknown error']);
});

// --- lib/roomHookState ---------------------------------------------------------

test('hook reducer ignores a fetch start for another room and unknown actions', () => {
    const state = createHookState('AAA111');

    const other = hookReducer(state, { type: 'fetch-start', roomCode: 'BBB222', requestId: 1, showLoading: true });
    const unknown = hookReducer(state, { type: 'nonsense' });

    assert.equal(other, state);
    assert.equal(unknown, state);
});

test('hook reducer applies presence and entity events to the room data', () => {
    const loaded = { ...createHookState('ABC234'), data: loadedState() };

    const withPresence = hookReducer(loaded, {
        type: 'presence',
        roomId: 'room1',
        players: [{ playerId: 'p1', online: true, lastSeen: 'now' }],
    });
    const withEvent = hookReducer(loaded, {
        type: 'event',
        entity: 'Player',
        event: { type: 'update', id: 'p2', data: makePlayer('p2', { name: 'Renamed' }) },
        meta: {},
    });

    assert.equal(withPresence.data.presence.p1.online, true);
    assert.equal(withEvent.data.players.p2.name, 'Renamed');
});

// --- lib/roomLoader ------------------------------------------------------------

test('fetchRoomSnapshot treats a room_not_found code as a missing room', async () => {
    const error = Object.assign(new Error('gone'), { data: { code: 'room_not_found' } });
    const api = { game: { lookupRoom: async () => Promise.reject(error) }, entities: {} };

    assert.equal(await fetchRoomSnapshot('ABC234', api), null);
});

test('fetchRoomSnapshot returns a non-member lookup without reading records', async () => {
    const lookup = { room: makeRoom(), players: [makePlayer('p9')], my_player: null };
    const api = { game: { lookupRoom: async () => lookup }, entities: {} };

    const snapshot = await fetchRoomSnapshot('ABC234', api);

    assert.deepEqual(snapshot, { room: lookup.room, players: lookup.players, myPlayerId: null });
});

test('fetchRoomSnapshot rethrows a record read failure that is not a 403', async () => {
    const failure = Object.assign(new Error('server down'), { status: 500 });
    const lookup = { room: makeRoom(), players: [], my_player: { id: 'p1' } };
    const failingRead = { filter: async () => Promise.reject(failure) };
    const api = {
        game: { lookupRoom: async () => lookup },
        entities: { GameRoom: failingRead, Player: failingRead, RoundScore: failingRead, ChatMessage: failingRead },
    };

    await assert.rejects(fetchRoomSnapshot('ABC234', api), { message: 'server down' });
});

// --- lib/roomState -------------------------------------------------------------

test('markRoomGone returns the same state when the room is already gone', () => {
    const gone = markRoomGone(loadedState());

    assert.equal(markRoomGone(gone), gone);
});

test('a GameRoom delete event without data keeps the last room', () => {
    const state = loadedState();

    const next = applyEvent(state, 'GameRoom', { type: 'delete', id: 'room1' });

    assert.equal(next.roomGone, true);
    assert.equal(next.room, state.room);
});

test('a snapshot without a version or myPlayerId still merges', () => {
    const next = applySnapshot(loadedState(), emptySnapshot(makeRoom({ version: undefined })));

    assert.equal(next.myPlayerId, null);
});

test('a snapshot keeps a locally newer room', () => {
    const update = { type: 'update', id: 'room1', data: makeRoom({ version: 5 }) };
    const newer = applyEvent(loadedState(), 'GameRoom', update, { roomVersion: 5 });

    const next = applySnapshot(newer, emptySnapshot(makeRoom({ version: 3 })));

    assert.equal(next.room.version, 5);
});

test('presence without a last seen time keeps what is known', () => {
    const known = [{ playerId: 'p1', online: true, lastSeen: 'a' }];
    const first = applyPresence(loadedState(), 'room1', known);

    const noSeen = applyPresence(first, 'room1', [{ playerId: 'p1', online: false }, { playerId: 'p2', online: true }]);

    assert.equal(noSeen.presence.p1.last_seen, 'a');
    assert.equal(noSeen.presence.p2.last_seen, null);
});

test('selectors handle a missing player record and unordered players', () => {
    const state = loadedState();
    const missingMe = { ...state, myPlayerId: 'ghost' };
    const ordered = { ...state, players: { b: makePlayer('b', { turn_order: 1 }), a: makePlayer('a') } };

    assert.equal(selectMyPlayer(missingMe), null);
    assert.deepEqual(selectSortedPlayers(ordered).map((player) => player.id), ['a', 'b']);
});

test('runAction clears the busy flag even when the toast itself throws', async () => {
    const busyStates = [];
    const options = {
        setBusy: (isBusy) => busyStates.push(isBusy),
        showToast: () => {
            throw new Error('toast broke');
        },
    };

    await assert.rejects(runAction('Save', () => Promise.reject(new Error('x')), options), { message: 'toast broke' });

    assert.deepEqual(busyStates, [true, false]);
});

test('an entity client subscribes through the realtime connection', () => {
    const calls = [];
    const realtime = {
        subscribe: (name, callback) => {
            calls.push(name);
            return callback;
        },
    };
    const callback = () => {};

    assert.equal(createEntityClient('Player', realtime).subscribe(callback), callback);
    assert.deepEqual(calls, ['Player']);
});

test('selectMyPlayer is null before I have joined', () => {
    assert.equal(selectMyPlayer(createRoomState()), null);
});
