import { SERVER_MESSAGE } from '../../../shared/realtimeProtocol.js';
import { createEntryStatusTracker, isEntryState } from './support/entryStatusTracker.js';

// Who in each room is entering their cards (X40): the entry-status messages, the entry status
// tracker (support/entryStatusTracker.js) and the `entry-status` state each room hears. Entries
// the room's latest state rules out are dropped after every publish, and expired ones on the
// periodic check.

/**
 * Whether this player can be entering cards for `round`: the round is open, and they haven't
 * scored it yet, which also stops a heartbeat that crossed their submit from bringing them back.
 */
function canEnterCards(room, player, round) {
    if (!room || !player) {
        return false;
    }
    return room.status === 'playing'
        && room.current_round === round
        && player.has_submitted_round !== true;
}

export class EntryStatusManager {
    #rooms;
    #players;
    #connections;
    #subscriptions;
    #lifecycle;
    #tracker;

    /**
     * `rooms` reads GameRooms ({ get(roomId) }) and `players` Players ({ listByRoom(roomId) }).
     * `clock` is the hub's Clock, `connections` the ConnectionManager, `subscriptions` the
     * SubscriptionManager and `lifecycle` the hub's Lifecycle, whose guard held statuses and
     * per-room reconciles run under.
     */
    constructor({ rooms, players, clock, connections, subscriptions, lifecycle }) {
        this.#rooms = rooms;
        this.#players = players;
        this.#connections = connections;
        this.#subscriptions = subscriptions;
        this.#lifecycle = lifecycle;
        this.#tracker = createEntryStatusTracker({ now: () => clock.now() });
    }

    // --- Messages ------------------------------------------------------------------

    /**
     * An entry-status message: a player saying they are scanning, typing or (null) done. It is
     * only advisory, so anything invalid is ignored without a reply. Stopping always counts, even
     * for a round that has ended. The checks before the player lookup are memory-only, so a flood
     * of these costs next to nothing.
     */
    receive(socket, message) {
        const { room_id: roomId, state, round } = message;
        const hasFields = typeof roomId === 'string'
            && Number.isInteger(round)
            && (state === null || isEntryState(state));
        if (!hasFields || !this.#subscriptions.isExplicitlySubscribed(socket, roomId)) {
            return;
        }

        const who = socket.identity.email;
        let isAdmitted;
        if (state === null) {
            isAdmitted = this.#tracker.admitClear(roomId, who);
        } else {
            // A state held past the window goes through the same checks then, so a submit, a kick
            // or a socket that has left the room since all stop it.
            const applyHeld = () => {
                this.#lifecycle.runGuarded('held entry status', () => this.#apply(socket, message));
            };
            isAdmitted = this.#tracker.admitAnnounce(roomId, who, { state, round }, applyHeld);
        }
        if (isAdmitted) {
            this.#apply(socket, message);
        }
    }

    /** Puts a checked and admitted status into effect, and tells the room if that changed anything. */
    #apply(socket, { room_id: roomId, state, round }) {
        const player = this.#subscriptions.findSubscribedPlayer(socket, roomId);
        if (!player) {
            return;
        }

        let hasChanged = false;
        if (state === null) {
            hasChanged = this.#tracker.clear(roomId, player.id);
        } else if (canEnterCards(this.#rooms.get(roomId), player, round)) {
            hasChanged = this.#tracker.set(roomId, player.id, { state, round });
        }

        if (hasChanged) {
            this.#broadcast(roomId);
        }
    }

    // --- Keeping entries current -----------------------------------------------------

    /**
     * After a publish touched these rooms (an iterable of ids): drops the entries each room's
     * latest state rules out. Each room runs under its own guard, so one failure doesn't stop
     * the rest.
     */
    reconcileRooms(roomIds) {
        for (const roomId of roomIds) {
            this.#lifecycle.runGuarded('entry status', () => this.#reconcile(roomId));
        }
    }

    /**
     * Drops the entries the room's latest state rules out. This one check covers a submit, a leave
     * or kick, a status change and the round moving on, whichever action caused them.
     */
    #reconcile(roomId) {
        if (!this.#tracker.hasEntries(roomId)) {
            return;
        }

        const room = this.#rooms.get(roomId);
        const players = this.#players.listByRoom(roomId);
        const hasChanged = this.#tracker.retain(roomId, (entry) => {
            const player = players.find((candidate) => candidate.id === entry.player_id);
            return canEnterCards(room, player, entry.round);
        });
        if (hasChanged) {
            this.#broadcast(roomId);
        }
    }

    /** Drops expired entries and tells each room that lost one (the periodic check). */
    sweepExpired() {
        for (const roomId of this.#tracker.sweepExpired()) {
            this.#broadcast(roomId);
        }
    }

    // --- Sending -------------------------------------------------------------------

    /** Sends the socket who is entering in the room, when anyone is. */
    sendState(socket, roomId) {
        const message = this.#buildMessage(roomId);
        if (message.entries.length > 0) {
            this.#connections.send(socket, message);
        }
    }

    #buildMessage(roomId) {
        return { type: SERVER_MESSAGE.ENTRY_STATUS, room_id: roomId, entries: this.#tracker.list(roomId) };
    }

    #broadcast(roomId) {
        this.#subscriptions.sendToRoom(roomId, this.#buildMessage(roomId));
    }

    /** Stops the timers of held statuses (the hub is closing). */
    close() {
        this.#tracker.close();
    }
}
