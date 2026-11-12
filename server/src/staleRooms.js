import { deleteRoomCascade } from './gameActions/rooms.js';
import { ROOM, runRoomAction, SYSTEM_USER } from './gameActions/roomTx.js';

// The stale-room sweep (X81). Rooms nobody has touched for STALE_ROOM_HOURS are deleted the same
// way the host's `delete` action does it: the room is published as closed, then it and its
// players, scores and chat are removed. A room with a player online is never swept, however long
// it has been idle. The sweep runs when the server starts listening and then every hour.

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** When the room was last touched in ms: its last action, or its creation when it has none yet. */
function lastTouchedMs(room) {
    const lastTouched = room.last_activity_date || room.created_date;
    return new Date(lastTouched).getTime();
}

/** Deletes one room as the server. True when it was deleted; a failure is logged and skipped. */
function deleteStaleRoom(context, roomId) {
    const request = { user: SYSTEM_USER, roomId, access: 'system', allowedStatuses: null };
    try {
        return runRoomAction(context, request, deleteRoomCascade).status === 200;
    } catch (error) {
        context.logger.error(`Deleting stale room ${roomId} failed`, error);
        return false;
    }
}

/** Ids of rooms last touched before `cutoffMs` with nobody online, oldest first. */
function findStaleRoomIds(context, cutoffMs) {
    const roomIds = [];
    for (const { record: room } of context.store.listRecords(ROOM)) {
        const isIdle = lastTouchedMs(room) < cutoffMs;
        if (isIdle && !context.hub.hasPlayersOnline(room.id)) {
            roomIds.push(room.id);
        }
    }
    return roomIds;
}

/** Runs `sweep`, logging a throw so the next hourly sweep still runs. */
function sweepSafely(logger, sweep) {
    try {
        sweep();
    } catch (error) {
        logger.error('Stale room sweep failed', error);
    }
}

/**
 * Builds the sweeper. `context` is the app context ({ store, hub, logger, ... }); `maxIdleMs` is
 * how long a room may sit untouched, or null to turn the sweep off; `now` is the clock in ms.
 * Returns { sweep, start, stop }. `sweep()` runs once and returns the deleted room ids.
 */
export function createStaleRoomSweeper({ context, maxIdleMs, now = Date.now }) {
    let timer = null;

    function sweep() {
        if (maxIdleMs === null) {
            return [];
        }

        const deletedRoomIds = [];
        for (const roomId of findStaleRoomIds(context, now() - maxIdleMs)) {
            if (deleteStaleRoom(context, roomId)) {
                deletedRoomIds.push(roomId);
            }
        }
        if (deletedRoomIds.length > 0) {
            context.logger.log(`Deleted ${deletedRoomIds.length} stale room(s)`);
        }
        return deletedRoomIds;
    }

    /** Sweeps now and then every hour. */
    function start() {
        if (maxIdleMs === null || timer !== null) {
            return;
        }

        sweepSafely(context.logger, sweep);
        timer = setInterval(() => sweepSafely(context.logger, sweep), SWEEP_INTERVAL_MS);
        // The sweep alone must not keep the process (or a test run) alive.
        timer.unref();
    }

    function stop() {
        clearInterval(timer);
        timer = null;
    }

    return { sweep, start, stop };
}
