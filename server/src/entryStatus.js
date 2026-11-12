// The "entering cards" signal (X40): who in a room is scanning or typing their cards right now.
// Advisory and in memory only, so it never touches a game action, `version` or the event log,
// and a restart loses it until clients re-announce on `ready`. This module only tracks entries;
// realtime.js checks the messages and broadcasts.
//
// An entry belongs to the player, not the socket, and ends by time rather than on close,
// because opening the camera kills the socket at the moment scanning starts (X26).

import { ENTRY_STATUS_TTL_MS } from '../../shared/realtimeProtocol.js';

// A member flipping between states would otherwise cost a database lookup and a room broadcast per
// message. A person can beat this with Scan, Back, Manual, so a change inside the window isn't lost:
// the latest one is held and applied as the window ends. Flooding still costs one lookup a second.
const ANNOUNCE_INTERVAL_MS = 1000;
// No entry outlives its last announce by more than this, so a throttle record can go after it.
const LONGEST_TTL_MS = Math.max(...Object.values(ENTRY_STATUS_TTL_MS));

export function isEntryState(state) {
    return typeof state === 'string' && Object.hasOwn(ENTRY_STATUS_TTL_MS, state);
}

function isSameLiveEntry(entry, { state, round }, now) {
    return entry !== undefined
        && entry.expiresAt > now
        && entry.state === state
        && entry.round === round;
}

function isSameStatus(first, second) {
    return first !== null && first.state === second.state && first.round === second.round;
}

/** Records an announce as the one going through now, which replaces anything held before it. */
function markAnnounced(throttle, status, time) {
    throttle.announcedAt = time;
    throttle.mayHoldEntry = true;
    throttle.lastStatus = status;
    throttle.held = null;
}

/**
 * Creates the tracker. `now` is the clock in ms. The methods that change entries return whether
 * what the room should see changed, so the caller knows when to broadcast.
 */
export function createEntryStatusTracker({ now }) {
    // roomId -> Map(playerId -> { state, round, expiresAt }). A room with no entries has no key.
    const rooms = new Map();
    // `${roomId}\n${who}` -> { announcedAt, mayHoldEntry, lastStatus, held, timer }. `who` identifies
    // the player before any database lookup, which is what these records save. `lastStatus` is the
    // last status let through, or null after a clear; `held` is { status, apply } for the latest one
    // waiting for the window to end; `timer` is what will apply it.
    const throttles = new Map();

    function throttleKey(roomId, who) {
        return `${roomId}\n${who}`;
    }

    function applyHeld(throttle) {
        throttle.timer = null;
        if (!throttle.held) {
            return;
        }

        const { status, apply } = throttle.held;
        markAnnounced(throttle, status, now());
        apply();
    }

    /**
     * Keeps the latest status from inside the window. There is one timer per record however many
     * arrive, and a repeat of what the room was last told needs none: it's only a heartbeat, or the
     * burst ended where it began.
     */
    function holdLatest(throttle, status, apply, time) {
        if (isSameStatus(throttle.lastStatus, status)) {
            throttle.held = null;
            return;
        }

        throttle.held = { status, apply };
        if (throttle.timer) {
            return;
        }

        const windowLeft = ANNOUNCE_INTERVAL_MS - (time - throttle.announcedAt);
        throttle.timer = setTimeout(() => applyHeld(throttle), windowLeft);
        // A held status isn't worth keeping the process alive for.
        throttle.timer.unref();
    }

    function deleteEntry(roomId, entries, playerId) {
        entries.delete(playerId);
        if (entries.size === 0) {
            rooms.delete(roomId);
        }
    }

    return {
        hasEntries(roomId) {
            return rooms.has(roomId);
        },

        /**
         * Whether to look at a non-null status from `who` at all: not within ANNOUNCE_INTERVAL_MS
         * of their last one. It counts every message, valid or not, because each costs a lookup.
         * That leaves a first announce untouched, and a repeated heartbeat costs under a second of
         * time to live. A different status inside the window is held, and `apply` runs as it ends.
         *
         * @param {{state: string, round: number}} status
         * @param {() => void} apply  does what an admitted status does, with its own checks, as
         *   anything may have changed by the time it runs
         */
        admitAnnounce(roomId, who, status, apply) {
            const time = now();
            const key = throttleKey(roomId, who);
            let throttle = throttles.get(key);
            if (throttle && time - throttle.announcedAt < ANNOUNCE_INTERVAL_MS) {
                holdLatest(throttle, status, apply, time);
                return false;
            }

            if (!throttle) {
                throttle = { timer: null };
                throttles.set(key, throttle);
            }
            markAnnounced(throttle, status, time);
            return true;
        },

        /**
         * Whether a null from `who` can have anything to clear. It is never delayed, but with no
         * announce since the last clear there is nothing for it to do, so it needs no lookup either.
         * Either way it cancels a held status: I have stopped entering, so that's out of date.
         */
        admitClear(roomId, who) {
            const throttle = throttles.get(throttleKey(roomId, who));
            if (!throttle) {
                return false;
            }

            throttle.held = null;
            throttle.lastStatus = null;
            if (!throttle.mayHoldEntry) {
                return false;
            }

            throttle.mayHoldEntry = false;
            return true;
        },

        /** Stops the timers of held statuses, for shutdown. */
        close() {
            for (const throttle of throttles.values()) {
                clearTimeout(throttle.timer);
                throttle.held = null;
            }
        },

        /** Adds or replaces a player's entry and restarts its time. A heartbeat changes nothing visible. */
        set(roomId, playerId, { state, round }) {
            let entries = rooms.get(roomId);
            if (!entries) {
                entries = new Map();
                rooms.set(roomId, entries);
            }

            const time = now();
            const isUnchanged = isSameLiveEntry(entries.get(playerId), { state, round }, time);
            entries.set(playerId, { state, round, expiresAt: time + ENTRY_STATUS_TTL_MS[state] });
            return !isUnchanged;
        },

        clear(roomId, playerId) {
            const entries = rooms.get(roomId);
            if (!entries?.has(playerId)) {
                return false;
            }

            deleteEntry(roomId, entries, playerId);
            return true;
        },

        /** Drops every entry `isValid({ player_id, round })` rejects. The room must have entries. */
        retain(roomId, isValid) {
            const entries = rooms.get(roomId);
            let hasChanged = false;
            for (const [playerId, entry] of [...entries]) {
                if (!isValid({ player_id: playerId, round: entry.round })) {
                    deleteEntry(roomId, entries, playerId);
                    hasChanged = true;
                }
            }
            return hasChanged;
        },

        /**
         * The room's live entries as sent to clients. An expired entry is left out but stays
         * stored until sweepExpired, so the sockets already in the room still hear it end.
         */
        list(roomId) {
            const time = now();
            const list = [];
            for (const [playerId, entry] of rooms.get(roomId) ?? []) {
                if (entry.expiresAt > time) {
                    list.push({ player_id: playerId, state: entry.state, round: entry.round });
                }
            }
            return list;
        },

        /** Removes expired entries and old throttle records; returns the ids of the rooms that lost an entry. */
        sweepExpired() {
            const time = now();
            for (const [key, throttle] of [...throttles]) {
                if (time - throttle.announcedAt >= LONGEST_TTL_MS && !throttle.held) {
                    throttles.delete(key);
                }
            }

            const changedRoomIds = [];
            for (const [roomId, entries] of [...rooms]) {
                let hasChanged = false;
                for (const [playerId, entry] of [...entries]) {
                    if (entry.expiresAt <= time) {
                        deleteEntry(roomId, entries, playerId);
                        hasChanged = true;
                    }
                }
                if (hasChanged) {
                    changedRoomIds.push(roomId);
                }
            }
            return changedRoomIds;
        },
    };
}
