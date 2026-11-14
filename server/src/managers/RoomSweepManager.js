// The stale-room sweep (X81). Rooms nobody has touched for STALE_ROOM_HOURS are deleted through
// the host's `delete` action, run as the server: the room is published as closed, then it and its
// players, scores and chat are removed. A room with a player online is never swept, however long
// it has been idle. The sweep runs when the server starts listening and then every hour.

export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export class RoomSweepManager {
    #rooms;
    #presence;
    #runner;
    #deleteAction;
    #clock;
    #logger;
    #maxIdleMs;
    #intervalMs;
    #timer = null;

    /**
     * `rooms` is the RoomRepository (its listIdle) and `presence` answers hasPlayersOnline(roomId)
     * (app.js passes the hub, so the answer is read through it at call time). `runner` is the
     * RoomActionRunner and `deleteAction` the registry's `delete` handler, which it runs as the
     * server. `clock` is a Clock and `logger` console-like. `maxIdleMs` is how long a room may sit
     * untouched, or null to turn the sweep off; `intervalMs` is how often it runs after the first.
     */
    constructor({
        rooms,
        presence,
        runner,
        deleteAction,
        clock,
        logger,
        maxIdleMs,
        intervalMs = SWEEP_INTERVAL_MS,
    }) {
        this.#rooms = rooms;
        this.#presence = presence;
        this.#runner = runner;
        this.#deleteAction = deleteAction;
        this.#clock = clock;
        this.#logger = logger;
        this.#maxIdleMs = maxIdleMs;
        this.#intervalMs = intervalMs;
    }

    /** Sweeps once. Returns the ids of the rooms it deleted, oldest first. */
    sweep() {
        if (this.#maxIdleMs === null) {
            return [];
        }

        const deletedRoomIds = [];
        for (const roomId of this.#findStaleRoomIds(this.#clock.now() - this.#maxIdleMs)) {
            if (this.#deleteRoom(roomId)) {
                deletedRoomIds.push(roomId);
            }
        }
        if (deletedRoomIds.length > 0) {
            this.#logger.log(`Deleted ${deletedRoomIds.length} stale room(s)`);
        }
        return deletedRoomIds;
    }

    /** Sweeps now and then every interval. Does nothing when the sweep is off or already started. */
    start() {
        if (this.#maxIdleMs === null || this.#timer !== null) {
            return;
        }

        this.#sweepSafely();
        this.#timer = setInterval(() => this.#sweepSafely(), this.#intervalMs);
        // The sweep alone must not keep the process (or a test run) alive.
        this.#timer.unref();
    }

    stop() {
        clearInterval(this.#timer);
        this.#timer = null;
    }

    /** Ids of rooms last touched before `cutoffMs` with nobody online, oldest first. */
    #findStaleRoomIds(cutoffMs) {
        const roomIds = [];
        for (const room of this.#rooms.listIdle(cutoffMs)) {
            if (!this.#presence.hasPlayersOnline(room.id)) {
                roomIds.push(room.id);
            }
        }
        return roomIds;
    }

    /** Deletes one room as the server. True when it was deleted; a failure is logged and skipped. */
    #deleteRoom(roomId) {
        try {
            return this.#runner.runAsSystem(this.#deleteAction, roomId, {}).status === 200;
        } catch (error) {
            this.#logger.error(`Deleting stale room ${roomId} failed`, error);
            return false;
        }
    }

    /** Sweeps, logging a throw so the next sweep still runs. */
    #sweepSafely() {
        try {
            this.sweep();
        } catch (error) {
            this.#logger.error('Stale room sweep failed', error);
        }
    }
}
