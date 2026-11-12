// Tests for useRoomData's node-testable parts: the hook reducer, the fetch coalescer and
// the room fetch. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHookState, hookReducer } from '../src/lib/roomHookState.js';
import { FetchCoalescer, fetchRoomSnapshot } from '../src/lib/roomLoader.js';

// --- Fixtures ----------------------------------------------------------------

const ROOM_ID = 'room1';
const ROOM_CODE = 'ABC234';

function makeRoom(overrides = {}) {
    return { id: ROOM_ID, code: ROOM_CODE, status: 'playing', version: 1, ...overrides };
}

function makePlayer(id, overrides = {}) {
    return { id, room_id: ROOM_ID, name: id, turn_order: 0, ...overrides };
}

function memberSnapshot(overrides = {}) {
    return {
        room: makeRoom(),
        players: [makePlayer('p1'), makePlayer('p2')],
        roundScores: [],
        chatMessages: [],
        myPlayerId: 'p1',
        ...overrides,
    };
}

function run(state, actions) {
    let next = state;
    for (const action of actions) {
        next = hookReducer(next, action);
    }
    return next;
}

function loadedHookState() {
    return run(createHookState(ROOM_CODE), [
        { type: 'fetch-start', roomCode: ROOM_CODE, requestId: 1, showLoading: true },
        { type: 'loaded', roomCode: ROOM_CODE, requestId: 1, snapshot: memberSnapshot() },
    ]);
}

/** A promise plus its resolve/reject, to finish a fake fetch when the test says so. */
function deferred() {
    const result = {};
    result.promise = new Promise((resolve, reject) => {
        result.resolve = resolve;
        result.reject = reject;
    });
    return result;
}

function notFoundError() {
    const error = new Error('Room not found');
    error.status = 404;
    error.data = { code: 'room_not_found' };
    return error;
}

/**
 * A fake API. `lookups` are answered in order (an Error is thrown); `rooms` is what the
 * member GameRoom read returns.
 */
function fakeApi({ lookups, rooms }) {
    const calls = { lookup: 0 };
    const filterReturning = (records) => ({ filter: async () => records });
    return {
        calls,
        game: {
            lookupRoom: async () => {
                const answer = lookups[calls.lookup];
                calls.lookup += 1;
                if (answer instanceof Error) {
                    throw answer;
                }
                return answer;
            },
        },
        entities: {
            GameRoom: filterReturning(rooms),
            Player: filterReturning([makePlayer('p1')]),
            RoundScore: filterReturning([]),
            ChatMessage: filterReturning([]),
        },
    };
}

// --- Hook reducer: loading ---------------------------------------------------

test('a first load goes loading -> ready', () => {
    let state = hookReducer(createHookState(ROOM_CODE), {
        type: 'fetch-start', roomCode: ROOM_CODE, requestId: 1, showLoading: true,
    });
    assert.equal(state.status, 'loading');

    state = hookReducer(state, { type: 'loaded', roomCode: ROOM_CODE, requestId: 1, snapshot: memberSnapshot() });
    assert.equal(state.status, 'ready');
    assert.equal(state.data.room.id, ROOM_ID);
    assert.deepEqual(state.fetchMarks, {});
});

test('an older fetch finishing after a newer one is applied is dropped', () => {
    const state = run(createHookState(ROOM_CODE), [
        { type: 'fetch-start', roomCode: ROOM_CODE, requestId: 1, showLoading: true },
        { type: 'fetch-start', roomCode: ROOM_CODE, requestId: 2, showLoading: false },
        { type: 'loaded', roomCode: ROOM_CODE, requestId: 2, snapshot: memberSnapshot({ room: makeRoom({ current_round: 5 }) }) },
        { type: 'loaded', roomCode: ROOM_CODE, requestId: 1, snapshot: memberSnapshot({ room: makeRoom({ current_round: 1 }) }) },
    ]);

    assert.equal(state.data.room.current_round, 5);
    assert.equal(state.appliedRequestId, 2);
});

test('a fetch for the old room code finishing after a room change is ignored', () => {
    let state = run(createHookState('OLD111'), [
        { type: 'fetch-start', roomCode: 'OLD111', requestId: 1, showLoading: true },
        { type: 'reset', roomCode: ROOM_CODE },
        { type: 'fetch-start', roomCode: ROOM_CODE, requestId: 2, showLoading: true },
    ]);
    const beforeLateAnswer = state;

    state = hookReducer(state, {
        type: 'loaded', roomCode: 'OLD111', requestId: 1, snapshot: memberSnapshot({ room: makeRoom({ id: 'old' }) }),
    });
    assert.equal(state, beforeLateAnswer);
    assert.equal(state.status, 'loading');

    state = hookReducer(state, { type: 'missing', roomCode: 'OLD111', requestId: 1 });
    assert.equal(state, beforeLateAnswer);
});

test('a fetch started before a reset to the same code is ignored', () => {
    const state = run(createHookState(ROOM_CODE), [
        { type: 'fetch-start', roomCode: ROOM_CODE, requestId: 1, showLoading: true },
        { type: 'reset', roomCode: ROOM_CODE },
        { type: 'loaded', roomCode: ROOM_CODE, requestId: 1, snapshot: memberSnapshot() },
    ]);

    assert.equal(state.data.room, null);
    assert.equal(state.status, 'loading');
});

test('no room code means missing', () => {
    const state = run(createHookState(null), [{ type: 'reset', roomCode: null }, { type: 'no-room' }]);
    assert.equal(state.status, 'missing');
});

// --- Hook reducer: missing and failed ----------------------------------------

test('finishMissing before anything loaded is "missing", not "gone"', () => {
    const state = run(createHookState(ROOM_CODE), [
        { type: 'fetch-start', roomCode: ROOM_CODE, requestId: 1, showLoading: true },
        { type: 'missing', roomCode: ROOM_CODE, requestId: 1 },
    ]);

    assert.equal(state.status, 'missing');
    assert.equal(state.data.roomGone, false);
});

test('finishMissing after a load marks the room gone', () => {
    const state = run(loadedHookState(), [
        { type: 'fetch-start', roomCode: ROOM_CODE, requestId: 2, showLoading: false },
        { type: 'missing', roomCode: ROOM_CODE, requestId: 2 },
    ]);

    assert.equal(state.status, 'ready');
    assert.equal(state.data.roomGone, true);
});

test('a failed refetch keeps the loaded data; a failed first load is an error', () => {
    const error = new Error('offline');
    const refetchFailed = run(loadedHookState(), [
        { type: 'fetch-start', roomCode: ROOM_CODE, requestId: 2, showLoading: false },
        { type: 'failed', roomCode: ROOM_CODE, requestId: 2, error },
    ]);
    assert.equal(refetchFailed.status, 'ready');
    assert.ok(refetchFailed.data.room);

    const firstFailed = run(createHookState(ROOM_CODE), [
        { type: 'fetch-start', roomCode: ROOM_CODE, requestId: 1, showLoading: true },
        { type: 'failed', roomCode: ROOM_CODE, requestId: 1, error },
    ]);
    assert.equal(firstFailed.status, 'error');
    assert.equal(firstFailed.error, error);
});

test('a snapshot knows which events arrived after its fetch started', () => {
    const state = run(loadedHookState(), [
        { type: 'fetch-start', roomCode: ROOM_CODE, requestId: 2, showLoading: false },
        {
            type: 'event',
            entity: 'Player',
            event: { type: 'update', id: 'p2', data: makePlayer('p2', { total_score: 10 }) },
            meta: { roomVersion: null },
        },
        {
            type: 'loaded',
            roomCode: ROOM_CODE,
            requestId: 2,
            snapshot: memberSnapshot({ players: [makePlayer('p1'), makePlayer('p2', { total_score: 0 })] }),
        },
    ]);

    assert.equal(state.data.players.p2.total_score, 10);
});

// --- Coalescer ---------------------------------------------------------------

test('triggers during a fetch coalesce into one queued rerun', async () => {
    const fetches = [];
    const coalescer = new FetchCoalescer((options) => {
        const fetch = deferred();
        fetches.push({ options, fetch });
        return fetch.promise;
    });

    const first = coalescer.request({ showLoading: false });
    const reconnect = coalescer.request({ showLoading: false });
    const focus = coalescer.request({ showLoading: false });
    const online = coalescer.request({ showLoading: false });
    assert.equal(fetches.length, 1);
    assert.equal(reconnect, focus);
    assert.equal(focus, online);

    fetches[0].fetch.resolve();
    await first;
    assert.equal(fetches.length, 2);

    fetches[1].fetch.resolve();
    await online;
    assert.equal(fetches.length, 2);
});

test('a queued rerun shows loading if any merged request asked for it', async () => {
    const fetches = [];
    const coalescer = new FetchCoalescer((options) => {
        fetches.push(options);
        return Promise.resolve();
    });

    const first = coalescer.request({ showLoading: false });
    coalescer.request({ showLoading: false });
    const retry = coalescer.request({ showLoading: true });
    await first;
    await retry;

    assert.deepEqual(fetches, [{ showLoading: false }, { showLoading: true }]);
});

test('a request after the fetch finished starts a new one', async () => {
    let count = 0;
    const coalescer = new FetchCoalescer(async () => {
        count += 1;
    });

    await coalescer.request({ showLoading: false });
    await coalescer.request({ showLoading: false });
    assert.equal(count, 2);
});

test('stop drops the queued rerun, settles its waiters and ignores later requests', async () => {
    const fetch = deferred();
    let count = 0;
    const coalescer = new FetchCoalescer(() => {
        count += 1;
        return fetch.promise;
    });

    coalescer.request({ showLoading: true });
    const queued = coalescer.request({ showLoading: false });
    coalescer.stop();
    await queued;

    fetch.resolve();
    await coalescer.request({ showLoading: false });
    assert.equal(count, 1);
});

test('a failed fetch still runs the queued rerun', async () => {
    let count = 0;
    const coalescer = new FetchCoalescer(async () => {
        count += 1;
        if (count === 1) {
            throw new Error('boom');
        }
    });

    const first = coalescer.request({ showLoading: false });
    const queued = coalescer.request({ showLoading: false });
    await assert.rejects(first);
    await queued;
    assert.equal(count, 2);
});

// --- fetchRoomSnapshot -------------------------------------------------------

test('a member gets the full snapshot', async () => {
    const api = fakeApi({
        lookups: [{ room: makeRoom(), players: [], my_player: makePlayer('p1') }],
        rooms: [makeRoom()],
    });

    const snapshot = await fetchRoomSnapshot(ROOM_CODE, api);
    assert.equal(snapshot.myPlayerId, 'p1');
    assert.equal(snapshot.room.id, ROOM_ID);
});

test('room_not_found from the lookup means gone (null)', async () => {
    const api = fakeApi({ lookups: [notFoundError()], rooms: [] });
    assert.equal(await fetchRoomSnapshot(ROOM_CODE, api), null);
});

test('an empty member read redoes the lookup: room gone', async () => {
    const api = fakeApi({
        lookups: [{ room: makeRoom(), players: [], my_player: makePlayer('p1') }, notFoundError()],
        rooms: [],
    });

    assert.equal(await fetchRoomSnapshot(ROOM_CODE, api), null);
    assert.equal(api.calls.lookup, 2);
});

test('a 403 member read (lock-down on, removed after the lookup) redoes the lookup', async () => {
    const api = fakeApi({
        lookups: [
            { room: makeRoom(), players: [], my_player: makePlayer('p1') },
            { room: makeRoom(), players: [], my_player: null },
        ],
        rooms: [],
    });
    const forbidden = Object.assign(new Error('Forbidden'), { status: 403 });
    api.entities.Player = { filter: async () => { throw forbidden; } };

    const snapshot = await fetchRoomSnapshot(ROOM_CODE, api);
    assert.equal(snapshot.myPlayerId, null);
    assert.equal(api.calls.lookup, 2);
});

test('an empty member read where the room still exists means I was removed, not gone', async () => {
    const api = fakeApi({
        lookups: [
            { room: makeRoom(), players: [], my_player: makePlayer('p1') },
            { room: makeRoom(), players: [{ id: 'p2', name: 'p2', turn_order: 0 }], my_player: null },
        ],
        rooms: [],
    });

    const snapshot = await fetchRoomSnapshot(ROOM_CODE, api);
    assert.equal(snapshot.myPlayerId, null);

    // Applied after a load, that's removedFromRoom rather than roomGone.
    const state = run(loadedHookState(), [
        { type: 'fetch-start', roomCode: ROOM_CODE, requestId: 2, showLoading: false },
        { type: 'loaded', roomCode: ROOM_CODE, requestId: 2, snapshot },
    ]);
    assert.equal(state.data.removedFromRoom, true);
    assert.equal(state.data.roomGone, false);
});

test('an empty member read while the lookup still says member is a failure, not gone', async () => {
    const lookup = { room: makeRoom(), players: [], my_player: makePlayer('p1') };
    const api = fakeApi({ lookups: [lookup, lookup], rooms: [] });

    await assert.rejects(fetchRoomSnapshot(ROOM_CODE, api));
});

test('other lookup errors are thrown', async () => {
    const error = new Error('server down');
    error.status = 503;
    const api = fakeApi({ lookups: [error], rooms: [] });

    await assert.rejects(fetchRoomSnapshot(ROOM_CODE, api), error);
});
