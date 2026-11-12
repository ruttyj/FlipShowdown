// Pure helpers for the hold-to-vote UI (see "Hold-to-vote" in docs/backend-contract.md).
// The server owns the holds and the timer. These helpers only keep the latest vote state
// per room and topic, and work out what to show for an option.

/** Only used to size the progress bar. */
export { VOTE_HOLD_MS } from '../../shared/realtimeProtocol.js';

/**
 * @typedef {object} VoteState
 * @property {string[]} eligible  ids of the players who can vote
 * @property {{ playerId: string, option: string }[]} holds
 * @property {{ option: string, remainingMs: number }|null} pending  the countdown, from `receivedAt`
 * @property {number} unlocksInMs  how long from `receivedAt` until the vote can pass; 0 when it can
 * @property {number} receivedAt  when this state arrived, so the times above can be reduced later
 */

// --- Shared store ------------------------------------------------------------------

function storeKey(roomId, topic) {
    return `${roomId}:${topic}`;
}

/**
 * One store for every hold-to-vote button on the page. The server sends a vote state only when
 * it changes (and once per room on `ready`), so a button that mounts during a vote must read the
 * state an earlier one left behind instead of starting empty.
 *
 * `set(roomId, topic, voteState)` replaces the state, `get(roomId, topic)` reads the latest (null
 * if none yet), and `subscribe(listener)` returns an unsubscribe function; listeners run after
 * every change. Fits React's useSyncExternalStore.
 */
export function createSharedVoteStore() {
    const states = new Map();
    const listeners = new Set();

    function set(roomId, topic, voteState) {
        states.set(storeKey(roomId, topic), voteState);
        for (const listener of listeners) {
            listener();
        }
    }

    function get(roomId, topic) {
        return states.get(storeKey(roomId, topic)) ?? null;
    }

    function subscribe(listener) {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }

    return { set, get, subscribe };
}

// --- Per-option display ----------------------------------------------------------

/** Milliseconds left on the server's countdown for the pending option, never below 0. */
export function remainingMsAt(voteState, now) {
    if (!voteState?.pending) {
        return 0;
    }

    const elapsed = now - voteState.receivedAt;
    return Math.max(0, voteState.pending.remainingMs - elapsed);
}

/**
 * Milliseconds until the vote can pass: the server waits a while after the host goes
 * offline before the others can vote without them. 0 when it can pass now.
 */
export function unlocksInMsAt(voteState, now) {
    if (!voteState) {
        return 0;
    }

    const elapsed = now - voteState.receivedAt;
    return Math.max(0, voteState.unlocksInMs - elapsed);
}

/** "m:ss", rounding up so the countdown reads 0:00 only once the time is up. */
export function formatCountdown(ms) {
    const totalSeconds = Math.ceil(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function holderIdsFor(voteState, option) {
    const holderIds = [];
    for (const hold of voteState.holds) {
        const isEligible = voteState.eligible.includes(hold.playerId);
        if (hold.option === option && isEligible) {
            holderIds.push(hold.playerId);
        }
    }
    return holderIds;
}

/**
 * What to show on the button for `option`:
 * - `pending`: the countdown is running. It can run without me (the host hands over alone).
 * - `mine`: I hold it, with or without others.
 * - `others`: other eligible players hold it and I don't.
 * - `idle`: nobody holds it.
 * Also returns `holderIds` (eligible holders), `iHold` and `remainingMs` (0 unless pending).
 */
export function optionState(voteState, option, myPlayerId, now) {
    if (!voteState) {
        return { status: 'idle', holderIds: [], iHold: false, remainingMs: 0 };
    }

    const holderIds = holderIdsFor(voteState, option);
    const iHold = holderIds.includes(myPlayerId);

    if (voteState.pending?.option === option) {
        return { status: 'pending', holderIds, iHold, remainingMs: remainingMsAt(voteState, now) };
    }
    if (iHold) {
        return { status: 'mine', holderIds, iHold, remainingMs: 0 };
    }
    if (holderIds.length > 0) {
        return { status: 'others', holderIds, iHold, remainingMs: 0 };
    }
    return { status: 'idle', holderIds, iHold, remainingMs: 0 };
}

// --- Replacing an offline host (display only, the server decides) ---------------------

/**
 * What a player who isn't the host sees of the vote for a new host:
 * - `hidden`: the host is online, or the wait isn't known yet.
 * - `waiting`: the host is offline and the vote is still locked.
 * - `open`: the vote can pass.
 * `offlineHostId` is null while the host is online. Presence arrives just before the vote
 * state, so one still counting that host as eligible predates them going offline and
 * its "no wait" means nothing.
 */
export function hostVoteStage(voteState, offlineHostId, now) {
    const isWaitKnown = voteState !== null && !voteState.eligible.includes(offlineHostId);
    if (offlineHostId === null || !isWaitKnown) {
        return 'hidden';
    }
    return unlocksInMsAt(voteState, now) > 0 ? 'waiting' : 'open';
}
