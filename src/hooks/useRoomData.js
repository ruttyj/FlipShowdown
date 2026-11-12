// The single owner of a room's client state: loads everything together, applies realtime
// events through the pure reducer in src/lib/roomState.js, and refetches whenever the data
// might be stale (the room channel says so, tab visible again, back online).
// Refetches are coalesced (src/lib/roomLoader.js): one in flight plus at most one queued.
// Writes are not done here; callers keep their own action handlers.

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { backend, roomChannel } from '@/api/backend';
import { game } from '@/api/game';
import { createHookState, hookReducer } from '@/lib/roomHookState';
import { FetchCoalescer, fetchRoomSnapshot } from '@/lib/roomLoader';
import {
    selectIsEditMode,
    selectIsHost,
    selectMyPlayer,
    selectRoundScores,
    selectScoresByRound,
    selectSortedPlayers,
} from '@/lib/roomState';

export { hookReducer } from '@/lib/roomHookState';

const LAST_ROOM_KEY = 'flip7_last_room';

// --- Effects helpers ---------------------------------------------------------

/**
 * One fetch of `roomCode`, reported to the reducer. Every action carries the room code,
 * so an answer that lands after a room change is ignored.
 */
async function loadRoom({ roomCode, requestId, showLoading, dispatch }) {
    dispatch({ type: 'fetch-start', roomCode, requestId, showLoading });

    try {
        const api = { game, entities: backend.entities };
        const snapshot = await fetchRoomSnapshot(roomCode, api);
        if (snapshot) {
            dispatch({ type: 'loaded', roomCode, requestId, snapshot });
        } else {
            dispatch({ type: 'missing', roomCode, requestId });
        }
    } catch (error) {
        console.error('Failed to load room:', error);
        dispatch({ type: 'failed', roomCode, requestId, error });
    }
}

/** Feeds the room's realtime traffic to the reducer until the returned leave() is called. */
function joinRoom(roomId, { dispatch, refetch }) {
    return roomChannel.joinRoom(roomId, {
        onRecordChange: (entity, event, meta) => dispatch({ type: 'event', entity, event, meta }),
        onPresence: (players) => dispatch({ type: 'presence', roomId, players }),
        onStale: () => refetch(),
    });
}

function readLastRoom() {
    try {
        return JSON.parse(localStorage.getItem(LAST_ROOM_KEY));
    } catch {
        return null;
    }
}

function saveLastRoom(roomCode) {
    try {
        localStorage.setItem(LAST_ROOM_KEY, JSON.stringify({ code: roomCode }));
    } catch {
        // Storage blocked (private mode): "Return to game" just won't be offered.
    }
}

function clearLastRoom(roomCode) {
    try {
        if (readLastRoom()?.code === roomCode) {
            localStorage.removeItem(LAST_ROOM_KEY);
        }
    } catch {
        // Storage blocked: nothing was stored either.
    }
}

// --- Hooks -------------------------------------------------------------------

/**
 * Calls `onTransition(previous, next)` after `value` changes (and once on mount, with
 * `previous` undefined). The previous value lives in a ref, so a transition is seen exactly
 * once however the value got there (bug 3.7).
 */
export function useValueTransition(value, onTransition) {
    const previousRef = useRef(undefined);
    const onTransitionRef = useRef(onTransition);

    // Declared first so the transition effect below always calls the latest callback.
    useEffect(() => {
        onTransitionRef.current = onTransition;
    });

    useEffect(() => {
        const previous = previousRef.current;
        previousRef.current = value;
        if (previous !== value) {
            onTransitionRef.current(previous, value);
        }
    }, [value]);
}

/**
 * Owns the coalescer for the current room code: created on each code change, stopped on
 * cleanup so no queued rerun of the old room starts. Returns stable `retry` and `refetch`.
 */
function useRoomLoader(roomCode, dispatch) {
    const coalescerRef = useRef(null);
    const requestCounterRef = useRef(0);

    useEffect(() => {
        dispatch({ type: 'reset', roomCode });
        if (!roomCode) {
            dispatch({ type: 'no-room' });
            return undefined;
        }

        const coalescer = new FetchCoalescer(({ showLoading }) => {
            requestCounterRef.current += 1;
            const requestId = requestCounterRef.current;
            return loadRoom({ roomCode, requestId, showLoading, dispatch });
        });
        coalescerRef.current = coalescer;
        coalescer.request({ showLoading: true });

        return () => {
            coalescer.stop();
            coalescerRef.current = null;
        };
    }, [roomCode, dispatch]);

    const retry = useCallback(() => {
        return coalescerRef.current?.request({ showLoading: true }) ?? Promise.resolve();
    }, []);
    const refetch = useCallback(() => {
        return coalescerRef.current?.request({ showLoading: false }) ?? Promise.resolve();
    }, []);

    return { retry, refetch };
}

/**
 * @param {string|null} roomCode
 * @returns {{
 *   status: 'loading'|'ready'|'missing'|'error', error: Error|null,
 *   retry: () => Promise<void>, refetch: () => Promise<void>,
 *   room: object|null, players: object[], myPlayer: object|null,
 *   isMember: boolean, isHost: boolean, isEditMode: boolean,
 *   roundScores: object[], scoresByRound: Object<number, object[]>, chatMessages: object[],
 *   roomGone: boolean, removedFromRoom: boolean,
 * }}
 *   `players` are sorted by turn order with `online`/`last_seen` from presence.
 */
export function useRoomData(roomCode) {
    const [state, dispatch] = useReducer(hookReducer, roomCode, createHookState);
    const { retry, refetch } = useRoomLoader(roomCode, dispatch);

    const { data } = state;
    const roomId = data.room?.id ?? null;
    const isMember = selectMyPlayer(data) !== null;
    const isSubscribed = roomId !== null && isMember && !data.roomGone;

    // Only members may subscribe; the server drops other room ids.
    useEffect(() => {
        if (!isSubscribed) {
            return undefined;
        }
        return joinRoom(roomId, { dispatch, refetch });
    }, [isSubscribed, roomId, refetch]);

    useEffect(() => {
        const refetchIfVisible = () => {
            if (document.visibilityState === 'visible') {
                refetch();
            }
        };
        document.addEventListener('visibilitychange', refetchIfVisible);
        window.addEventListener('online', refetch);
        return () => {
            document.removeEventListener('visibilitychange', refetchIfVisible);
            window.removeEventListener('online', refetch);
        };
    }, [refetch]);

    // Remember the room for "Return to game" while I'm in it (bug 7.8).
    useEffect(() => {
        if (!roomCode) {
            return;
        }
        if (data.roomGone || data.removedFromRoom) {
            clearLastRoom(roomCode);
        } else if (isMember) {
            saveLastRoom(roomCode);
        }
    }, [roomCode, isMember, data.roomGone, data.removedFromRoom]);

    return useMemo(() => ({
        status: state.status,
        error: state.error,
        retry,
        refetch,
        room: data.room,
        players: selectSortedPlayers(data),
        myPlayer: selectMyPlayer(data),
        isMember,
        isHost: selectIsHost(data),
        isEditMode: selectIsEditMode(data),
        roundScores: selectRoundScores(data),
        scoresByRound: selectScoresByRound(data),
        chatMessages: Object.values(data.chatMessages),
        roomGone: data.roomGone,
        removedFromRoom: data.removedFromRoom,
    }), [state.status, state.error, data, isMember, retry, refetch]);
}
