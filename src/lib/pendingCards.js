// Cards a player is entering for a round, kept in sessionStorage so they survive the tab
// being discarded while the camera is open, a reload, or the entry screen unmounting while
// the host edits scores (bugs 7.5, 7.11). Cleared once the score is accepted.
//
// Every function takes the storage object as an argument (null when storage is blocked) so
// the logic can be tested without a browser.
//
// Drafts are kept per scope, one game in one room (see pendingCardsScope), so a draft from an
// earlier game in the same room never comes back in a later one, even when the tab missed the
// game ending (X5).

const KEY_PREFIX = 'flip7_pending_cards';
const ENTRY_SOURCES = ['scanner', 'manual'];

/**
 * The scope drafts are kept under: one game in one room, e.g. ('r1', 2) -> 'r1:g2'.
 * gameNumber is the room's game_number; a room saved before that field existed is on game 1.
 */
export function pendingCardsScope(roomId, gameNumber) {
    return `${roomId}:g${gameNumber ?? 1}`;
}

/** The storage key for one scope and round, e.g. ('r1:g2', 3) -> 'flip7_pending_cards:r1:g2:3'. */
export function pendingCardsKey(scope, roundNumber) {
    return `${KEY_PREFIX}:${scope}:${roundNumber}`;
}

/** sessionStorage, or null when the browser blocks it (accessing it can throw). */
export function browserSessionStorage() {
    try {
        return globalThis.sessionStorage ?? null;
    } catch {
        return null;
    }
}

function isValidEntry(entry) {
    return entry !== null
        && typeof entry === 'object'
        && ENTRY_SOURCES.includes(entry.source)
        && Array.isArray(entry.cards);
}

/**
 * @param {Storage|null} storage
 * @param {string} scope  from pendingCardsScope
 * @param {{source: 'scanner'|'manual', cards: object[], duplicateAllowed?: boolean, flip7AttackPlayerId?: string}} entry
 *        which screen the cards were entered on (to reopen it after a reload), the cards so far,
 *        whether their duplicate was vouched for as coming from a Steal or Swap, and who their Flip 7
 *        takes 15 from
 */
export function savePendingCards(storage, scope, roundNumber, entry) {
    if (!storage) {
        return;
    }

    try {
        storage.setItem(pendingCardsKey(scope, roundNumber), JSON.stringify(entry));
    } catch {
        // Storage full or blocked: the cards only live in component state then.
    }
}

/** @returns {{source: 'scanner'|'manual', cards: object[], duplicateAllowed?: boolean, flip7AttackPlayerId?: string}|null} null when nothing valid is saved */
export function loadPendingCards(storage, scope, roundNumber) {
    if (!storage) {
        return null;
    }

    try {
        const entry = JSON.parse(storage.getItem(pendingCardsKey(scope, roundNumber)));
        if (isValidEntry(entry)) {
            return entry;
        }
        return null;
    } catch {
        return null;
    }
}

export function clearPendingCards(storage, scope, roundNumber) {
    if (!storage) {
        return;
    }

    try {
        storage.removeItem(pendingCardsKey(scope, roundNumber));
    } catch {
        // Storage blocked: nothing was saved either.
    }
}

/**
 * The rounds of this scope (one game in one room) that have pending cards saved, in
 * ascending order. Keys of other games, other rooms, other apps and malformed round numbers
 * are ignored, as are keys from before drafts were kept per game ('flip7_pending_cards:r1:3').
 */
export function listPendingRounds(storage, scope) {
    if (!storage) {
        return [];
    }

    const prefix = `${KEY_PREFIX}:${scope}:`;
    const rounds = [];
    try {
        for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (typeof key !== 'string' || !key.startsWith(prefix)) {
                continue;
            }

            const round = Number(key.slice(prefix.length));
            if (Number.isInteger(round)) {
                rounds.push(round);
            }
        }
    } catch {
        // Storage blocked: nothing can have been saved.
        return [];
    }
    return rounds.sort((a, b) => a - b);
}

/**
 * Removes the room's draft keys that `shouldRemove(key)` picks. Collects the keys before
 * removing any, since removing shifts the storage indexes.
 */
function removeRoomKeys(storage, roomId, shouldRemove) {
    if (!storage) {
        return;
    }

    const roomPrefix = `${KEY_PREFIX}:${roomId}:`;
    try {
        const keys = [];
        for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            const isRoomKey = typeof key === 'string' && key.startsWith(roomPrefix);
            if (isRoomKey && shouldRemove(key)) {
                keys.push(key);
            }
        }
        for (const key of keys) {
            storage.removeItem(key);
        }
    } catch {
        // Storage blocked: nothing can have been saved.
    }
}

/**
 * Removes every pending card of this room, from every game and in the old key format, e.g.
 * once the game is no longer playing.
 */
export function clearRoomPendingCards(storage, roomId) {
    removeRoomKeys(storage, roomId, () => true);
}

/**
 * Removes this room's pending cards that don't belong to `scope`: drafts from earlier games
 * (left behind when the tab missed the game ending) and drafts in the old key format.
 */
export function clearOtherGamesPendingCards(storage, roomId, scope) {
    const scopePrefix = `${KEY_PREFIX}:${scope}:`;
    removeRoomKeys(storage, roomId, (key) => !key.startsWith(scopePrefix));
}

/**
 * What to do with the pending cards found after a reload.
 *
 * @param {{rounds: number[], currentRound: number, hasSubmittedCurrent: boolean, isHost: boolean}} details
 *        `rounds` from listPendingRounds
 * @returns {{restoreCurrent: boolean, resolve: number[], clear: number[]}}
 *   - restoreCurrent: reopen the entry for the current round.
 *   - resolve: older rounds the host is asked about (the "round moved on" prompt), so they
 *     can be put into the score editor.
 *   - clear: rounds to drop: the current round once its score went through (the response
 *     was lost before it could be cleared), older rounds for everyone but the host (only
 *     the host can edit a closed round), and rounds after the current one (left over from
 *     an earlier game in this room).
 */
export function planPendingRestore({ rounds, currentRound, hasSubmittedCurrent, isHost }) {
    const plan = { restoreCurrent: false, resolve: [], clear: [] };

    for (const round of rounds) {
        const isCurrent = round === currentRound;
        if (isCurrent && hasSubmittedCurrent) {
            plan.clear.push(round);
        } else if (isCurrent) {
            plan.restoreCurrent = true;
        } else if (round < currentRound && isHost) {
            plan.resolve.push(round);
        } else {
            plan.clear.push(round);
        }
    }
    return plan;
}
