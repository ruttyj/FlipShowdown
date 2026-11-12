// The reducer behind useRoomData: fetch bookkeeping around the pure room state in
// roomState.js. No React, so it can be tested in node.

import { applyEvent, applyPresence, applySnapshot, createRoomState, markRoomGone } from './roomState.js';

/**
 * status: 'loading' | 'ready' | 'missing' | 'error'.
 * roomCode: the room this state is for. Fetch actions carry the code they were started
 * for, and answers for another code (a fetch still in flight from before a room change)
 * are ignored.
 * fetchMarks: requestId -> data.eventIndex when that fetch started, so its snapshot knows
 * which events happened after it was requested. Only fetches started since the last reset
 * have a mark; answers without one are ignored.
 * appliedRequestId: the newest fetch whose answer was used; older answers are dropped.
 *
 * @param {string|null} [roomCode]
 */
export function createHookState(roomCode = null) {
    return {
        roomCode,
        status: 'loading',
        error: null,
        fetchMarks: {},
        appliedRequestId: 0,
        data: createRoomState(),
    };
}

function withoutMark(fetchMarks, requestId) {
    const next = { ...fetchMarks };
    delete next[requestId];
    return next;
}

function startFetch(state, { requestId, showLoading }) {
    const fetchMarks = { ...state.fetchMarks, [requestId]: state.data.eventIndex };
    if (showLoading) {
        return { ...state, fetchMarks, status: 'loading', error: null };
    }
    return { ...state, fetchMarks };
}

function finishLoaded(state, { requestId, snapshot, sinceEvent }) {
    return {
        ...state,
        status: 'ready',
        error: null,
        appliedRequestId: requestId,
        data: applySnapshot(state.data, { ...snapshot, sinceEvent }),
    };
}

/**
 * The lookup said the room doesn't exist. Before anything loaded that's "missing"; after
 * that it means the room is gone.
 */
function finishMissing(state, { requestId }) {
    if (state.data.room) {
        return { ...state, appliedRequestId: requestId, data: markRoomGone(state.data) };
    }
    return { ...state, status: 'missing', appliedRequestId: requestId };
}

/** A failed refetch keeps showing the data we have; only a failed first load is an error. */
function finishFailed(state, { requestId, error }) {
    if (state.data.room) {
        return state;
    }
    return { ...state, status: 'error', error, appliedRequestId: requestId };
}

function finishFetch(state, action) {
    const sinceEvent = state.fetchMarks[action.requestId];
    const isFromBeforeReset = sinceEvent === undefined;
    if (isFromBeforeReset) {
        return state;
    }

    const settled = { ...state, fetchMarks: withoutMark(state.fetchMarks, action.requestId) };
    const isSuperseded = action.requestId < state.appliedRequestId;
    if (isSuperseded) {
        return settled;
    }

    if (action.type === 'loaded') {
        return finishLoaded(settled, { ...action, sinceEvent });
    }
    if (action.type === 'missing') {
        return finishMissing(settled, action);
    }
    return finishFailed(settled, action);
}

function isForOtherRoom(state, action) {
    return action.roomCode !== state.roomCode;
}

/**
 * Actions:
 * - {type: 'reset', roomCode}: start over for a (new) room code.
 * - {type: 'no-room'}: there is no room code to load.
 * - {type: 'fetch-start', roomCode, requestId, showLoading}
 * - {type: 'loaded', roomCode, requestId, snapshot}, {type: 'missing', roomCode, requestId},
 *   {type: 'failed', roomCode, requestId, error}
 * - {type: 'event', entity, event, meta}, {type: 'presence', roomId, players}
 */
export function hookReducer(state, action) {
    switch (action.type) {
        case 'reset':
            return createHookState(action.roomCode);
        case 'no-room':
            return { ...state, status: 'missing' };
        case 'fetch-start':
            if (isForOtherRoom(state, action)) {
                return state;
            }
            return startFetch(state, action);
        case 'loaded':
        case 'missing':
        case 'failed':
            if (isForOtherRoom(state, action)) {
                return state;
            }
            return finishFetch(state, action);
        case 'event':
            return { ...state, data: applyEvent(state.data, action.entity, action.event, action.meta) };
        case 'presence':
            return { ...state, data: applyPresence(state.data, action.roomId, action.players) };
        default:
            return state;
    }
}
