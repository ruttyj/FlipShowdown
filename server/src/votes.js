import { VOTE_HOLD_MS } from '../../shared/realtimeProtocol.js';

// Hold-to-vote: a server-owned unanimous vote per room and topic. Every
// eligible (online) player holds the same option, and after `holdMs` of that
// the topic's decision is carried out. This module only tracks holds, the
// electorate and the pending timer; realtime.js feeds it and broadcasts.

// How long the host must have been offline before a vote can pass without
// them, so a host who only switched app or lost signal briefly keeps the role.
export const HOST_OFFLINE_GRACE_MS = 2 * 60 * 1000;

// --- Electorate ------------------------------------------------------------

/**
 * How many eligible voters a vote needs: 2, or 1 when the current host is
 * offline (otherwise a 2-player room whose host's phone died could never
 * pick a new host).
 */
function requiredVoters(electorate) {
    const isHostOnline = electorate.hostPlayerId !== null
        && electorate.onlinePlayerIds.includes(electorate.hostPlayerId);
    if (isHostOnline) {
        return 2;
    }
    return 1;
}

function emptyElectorate() {
    return { onlinePlayerIds: [], hostPlayerId: null, lockedUntil: null };
}

/**
 * When votes open, as a clock time: `hostGraceMs` after an offline host was
 * last seen. Null when they are open now, including when the host is online
 * or was never seen.
 */
function lockedUntilOf({ onlinePlayerIds, hostPlayerId }, hostOfflineSince, now, hostGraceMs) {
    const isHostOffline = hostPlayerId !== null && !onlinePlayerIds.includes(hostPlayerId);
    if (!isHostOffline || hostOfflineSince === null) {
        return null;
    }

    const lockedUntil = hostOfflineSince + hostGraceMs;
    if (lockedUntil <= now) {
        return null;
    }
    return lockedUntil;
}

/** Sorted copy, so the same set of players always compares equal. */
function normaliseElectorate({ onlinePlayerIds, hostPlayerId, hostOfflineSince = null }, now, hostGraceMs) {
    const electorate = {
        onlinePlayerIds: [...new Set(onlinePlayerIds)].sort(),
        hostPlayerId: hostPlayerId ?? null,
    };
    electorate.lockedUntil = lockedUntilOf(electorate, hostOfflineSince, now, hostGraceMs);
    return electorate;
}

function isSameElectorate(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

// --- Holds -----------------------------------------------------------------

/**
 * A topic's holds: playerId -> { option, socketIds: Set }. A player holds one
 * option; several sockets of the same user may own it, and the hold lasts
 * until the last of them lets go.
 *
 * Both helpers return whether the visible state changed: which option each
 * player holds, if any. Another socket of the same user joining or leaving a
 * hold that stays isn't a change.
 */
function addHold(holds, { socketId, playerId, option }) {
    const existing = holds.get(playerId);
    if (existing && existing.option === option) {
        existing.socketIds.add(socketId);
        return false;
    }

    // A new option replaces the player's old hold, whichever socket owned it.
    holds.set(playerId, { option, socketIds: new Set([socketId]) });
    return true;
}

function removeSocketHolds(holds, socketId) {
    let changed = false;
    for (const [playerId, hold] of holds) {
        const wasLastSocket = hold.socketIds.delete(socketId) && hold.socketIds.size === 0;
        if (wasLastSocket) {
            holds.delete(playerId);
            changed = true;
        }
    }
    return changed;
}

/** The option the online host holds, or undefined when they hold none or are offline. */
function onlineHostOption(holds, { onlinePlayerIds, hostPlayerId }) {
    if (!onlinePlayerIds.includes(hostPlayerId)) {
        return undefined;
    }
    return holds.get(hostPlayerId)?.option;
}

/**
 * The option every eligible voter holds, or null when they don't agree. In a
 * topic the host decides, the online host's hold alone is enough.
 */
function unanimousOption(holds, electorate, hostDecides) {
    const hostOption = hostDecides ? onlineHostOption(holds, electorate) : undefined;
    if (hostOption !== undefined) {
        return hostOption;
    }

    const eligible = electorate.onlinePlayerIds;
    if (electorate.lockedUntil !== null || eligible.length < requiredVoters(electorate)) {
        return null;
    }

    const firstOption = holds.get(eligible[0])?.option;
    if (firstOption === undefined) {
        return null;
    }
    for (const playerId of eligible) {
        if (holds.get(playerId)?.option !== firstOption) {
            return null;
        }
    }
    return firstOption;
}

// --- Tracker ---------------------------------------------------------------

/**
 * Creates the vote tracker. Options:
 *   topics - the topic names; every room has a state for each
 *   hostDecidesTopics - topic names where the online host holding an option
 *     passes it without anyone else
 *   holdMs - how long everyone must hold before the vote passes
 *   timers - { setTimeout, clearTimeout } (tests pass fakes)
 *   hostGraceMs - how long after an offline host was last seen votes stay
 *     locked
 *   timers - { setTimeout, clearTimeout } (tests pass fakes)
 *   now - clock in ms, used for `remaining_ms` and `unlocks_in_ms`
 *   onPassed(roomId, topic, option) - called when a vote passes, after that
 *     topic's holds were cleared
 *   onChanged(changes) - called with the room's topics when they unlock on
 *     their own, since no method call returns that change
 *
 * Every mutating method returns the topics whose state changed, as
 * [{ roomId, topic }], so the caller knows what to broadcast. A pending timer
 * restarts only when the electorate or the unanimous option changes; a hold
 * change that leaves both alone (for example an offline player's) keeps it.
 */
export function createVoteTracker({
    topics,
    hostDecidesTopics = [],
    holdMs = VOTE_HOLD_MS,
    hostGraceMs = HOST_OFFLINE_GRACE_MS,
    timers = { setTimeout, clearTimeout },
    now = Date.now,
    onPassed,
    onChanged = () => {},
}) {
    // roomId -> { electorate, unlockTimer, topics: Map(topic -> { holds, pending }) }
    const rooms = new Map();

    function getRoom(roomId) {
        let room = rooms.get(roomId);
        if (!room) {
            room = { electorate: emptyElectorate(), unlockTimer: null, topics: new Map() };
            rooms.set(roomId, room);
        }
        return room;
    }

    function restartAllTimers(roomId, room) {
        const changed = [];
        for (const topic of topics) {
            restartTimer(roomId, room, topic);
            changed.push({ roomId, topic });
        }
        return changed;
    }

    function cancelUnlock(room) {
        if (room.unlockTimer !== null) {
            timers.clearTimeout(room.unlockTimer);
            room.unlockTimer = null;
        }
    }

    function unlock(roomId, room) {
        room.unlockTimer = null;
        room.electorate = { ...room.electorate, lockedUntil: null };
        onChanged(restartAllTimers(roomId, room));
    }

    function scheduleUnlock(roomId, room) {
        cancelUnlock(room);
        const { lockedUntil } = room.electorate;
        if (lockedUntil !== null) {
            room.unlockTimer = timers.setTimeout(() => unlock(roomId, room), lockedUntil - now());
        }
    }

    function getTopic(room, topic) {
        let state = room.topics.get(topic);
        if (!state) {
            state = { holds: new Map(), pending: null };
            room.topics.set(topic, state);
        }
        return state;
    }

    function agreedOption(room, topic) {
        return unanimousOption(getTopic(room, topic).holds, room.electorate, hostDecidesTopics.includes(topic));
    }

    function cancelPending(state) {
        if (state.pending) {
            timers.clearTimeout(state.pending.timer);
            state.pending = null;
        }
    }

    function pass(roomId, topic) {
        const state = rooms.get(roomId)?.topics.get(topic);
        if (!state?.pending) {
            return;
        }

        const { option } = state.pending;
        state.pending = null;
        state.holds.clear();
        onPassed(roomId, topic, option);
    }

    /** Cancels the topic's timer and starts a fresh one if everyone agrees. */
    function restartTimer(roomId, room, topic) {
        const state = getTopic(room, topic);
        cancelPending(state);

        const option = agreedOption(room, topic);
        if (option === null) {
            return;
        }
        const timer = timers.setTimeout(() => pass(roomId, topic), holdMs);
        state.pending = { option, startedAt: now(), timer };
    }

    /** After a hold change: keeps a running timer whose option is still unanimous, else restarts. */
    function updateTimer(roomId, room, topic) {
        const state = getTopic(room, topic);
        const option = agreedOption(room, topic);
        const isStillAgreed = state.pending !== null && state.pending.option === option;
        if (isStillAgreed) {
            return;
        }
        restartTimer(roomId, room, topic);
    }

    return {
        /** Records a hold from one socket of `playerId`. */
        hold(roomId, topic, { socketId, playerId, option }) {
            const room = getRoom(roomId);
            if (!addHold(getTopic(room, topic).holds, { socketId, playerId, option })) {
                return [];
            }
            updateTimer(roomId, room, topic);
            return [{ roomId, topic }];
        },

        /** Drops this socket's hold in one topic. */
        release(roomId, topic, socketId) {
            const room = rooms.get(roomId);
            const state = room?.topics.get(topic);
            if (!state || !removeSocketHolds(state.holds, socketId)) {
                return [];
            }
            updateTimer(roomId, room, topic);
            return [{ roomId, topic }];
        },

        /**
         * Drops every hold this socket owns, in `roomIds` (an iterable) or in
         * every room when it's omitted (the socket closed).
         */
        dropSocket(socketId, roomIds = rooms.keys()) {
            const changed = [];
            for (const roomId of [...roomIds]) {
                const room = rooms.get(roomId);
                if (!room) {
                    continue;
                }
                for (const [topic, state] of room.topics) {
                    if (removeSocketHolds(state.holds, socketId)) {
                        updateTimer(roomId, room, topic);
                        changed.push({ roomId, topic });
                    }
                }
            }
            return changed;
        },

        /**
         * Sets who is online in the room and who is host:
         * { onlinePlayerIds: [playerId], hostPlayerId: playerId | null,
         *   hostOfflineSince: ms | null }. `hostOfflineSince` is when an
         * offline host was last seen; null when unknown, which doesn't lock.
         * `force` counts as a change even if the electorate is the same, for
         * joins, leaves and kicks of offline players. Returns the room's
         * topics when anything changed.
         */
        setElectorate(roomId, electorate, { force = false } = {}) {
            const room = getRoom(roomId);
            const next = normaliseElectorate(electorate, now(), hostGraceMs);
            if (!force && isSameElectorate(room.electorate, next)) {
                return [];
            }

            room.electorate = next;
            scheduleUnlock(roomId, room);
            return restartAllTimers(roomId, room);
        },

        /**
         * The topic's state as the `vote` message carries it:
         * { eligible: [playerId], holds: [{ player_id, option }],
         *   pending: { option, remaining_ms } | null, unlocks_in_ms }.
         * `unlocks_in_ms` is how long until the vote can pass, 0 when it can.
         * Only eligible players' holds are listed; an offline player's hold is
         * kept but doesn't count until they are online again.
         */
        snapshot(roomId, topic) {
            const room = rooms.get(roomId);
            const electorate = room?.electorate ?? emptyElectorate();
            const state = room?.topics.get(topic);

            const holds = [];
            for (const playerId of electorate.onlinePlayerIds) {
                const hold = state?.holds.get(playerId);
                if (hold) {
                    holds.push({ player_id: playerId, option: hold.option });
                }
            }

            let pending = null;
            if (state?.pending) {
                const elapsed = now() - state.pending.startedAt;
                pending = { option: state.pending.option, remaining_ms: Math.max(0, holdMs - elapsed) };
            }
            let unlocksInMs = 0;
            if (electorate.lockedUntil !== null) {
                unlocksInMs = Math.max(0, electorate.lockedUntil - now());
            }
            return { eligible: electorate.onlinePlayerIds, holds, pending, unlocks_in_ms: unlocksInMs };
        },

        /** Forgets a room nobody is watching any more, cancelling its timers. */
        forgetRoom(roomId) {
            const room = rooms.get(roomId);
            if (!room) {
                return;
            }
            cancelUnlock(room);
            for (const state of room.topics.values()) {
                cancelPending(state);
            }
            rooms.delete(roomId);
        },

        /** Cancels every timer (the hub is closing). */
        close() {
            for (const roomId of [...rooms.keys()]) {
                this.forgetRoom(roomId);
            }
        },
    };
}
