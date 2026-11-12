// Loading a room for useRoomData: the fetch itself (with its API passed in, so it runs in
// node tests) and the coalescer that keeps refetch triggers from piling up.

// --- Fetching ----------------------------------------------------------------

function isRoomNotFound(error) {
    return error?.status === 404 || error?.data?.code === 'room_not_found';
}

/** @returns {Promise<object|null>} the by-code lookup, or null when the room doesn't exist */
async function lookupRoom(roomCode, api) {
    try {
        return await api.game.lookupRoom(roomCode);
    } catch (error) {
        if (isRoomNotFound(error)) {
            return null;
        }
        throw error;
    }
}

/** Non-members only get the lookup's names (no emails); applySnapshot spots a removal. */
function nonMemberSnapshot(lookup) {
    return { room: lookup.room, players: lookup.players, myPlayerId: null };
}

function readRoomRecords(roomId, entities) {
    return Promise.all([
        entities.GameRoom.filter({ id: roomId }),
        entities.Player.filter({ room_id: roomId }),
        entities.RoundScore.filter({ room_id: roomId }),
        entities.ChatMessage.filter({ room_id: roomId }),
    ]);
}

/** @returns {Promise<object|null>} the full member snapshot, or null when the room read is empty */
async function readMemberSnapshot(lookup, api) {
    let records;
    try {
        records = await readRoomRecords(lookup.room.id, api.entities);
    } catch (error) {
        // With LOCK_GAME_ENTITIES on, a player removed after the lookup gets 403 rather
        // than an empty read; both mean "check again".
        if (error?.status === 403) {
            return null;
        }
        throw error;
    }

    const [rooms, players, roundScores, chatMessages] = records;

    if (rooms.length === 0) {
        return null;
    }
    return { room: rooms[0], players, roundScores, chatMessages, myPlayerId: lookup.my_player.id };
}

/**
 * Loads the whole room. Members get full records through the entity reads.
 *
 * @param {string} roomCode
 * @param {{game: {lookupRoom: Function}, entities: object}} api
 * @returns {Promise<object|null>} a snapshot for applySnapshot, or null only when the lookup
 *          says the room doesn't exist (or is closed)
 */
export async function fetchRoomSnapshot(roomCode, api) {
    const lookup = await lookupRoom(roomCode, api);
    if (!lookup) {
        return null;
    }
    if (!lookup.my_player) {
        return nonMemberSnapshot(lookup);
    }

    const snapshot = await readMemberSnapshot(lookup, api);
    if (snapshot) {
        return snapshot;
    }

    // The member reads only return rooms I'm in, so an empty read means the room was
    // deleted or I was removed after the lookup. Only a fresh lookup can tell which.
    const recheck = await lookupRoom(roomCode, api);
    if (!recheck) {
        return null;
    }
    if (!recheck.my_player) {
        return nonMemberSnapshot(recheck);
    }
    // Still a member, yet the read was empty: treat it as a failed fetch, not a gone room.
    throw new Error('Room read came back empty for a member');
}

// --- Coalescing --------------------------------------------------------------

/**
 * Runs at most one fetch at a time, plus at most one queued rerun. Triggers that arrive
 * while a fetch is in flight (reconnect, focus, online) share that one rerun, which starts
 * after the current fetch so it sees everything up to the latest trigger.
 *
 * `runFetch({showLoading})` must return a promise. Queued requests merge: the rerun shows
 * loading if any of them asked for it.
 */
export class FetchCoalescer {
    constructor(runFetch) {
        this.runFetch = runFetch;
        this.isRunning = false;
        this.isStopped = false;
        /** @type {{options: {showLoading: boolean}, resolve: Function, promise: Promise<void>}|null} */
        this.queued = null;
    }

    /** @returns {Promise<void>} settles when a fetch started at or after this call finishes */
    request(options) {
        if (this.isStopped) {
            return Promise.resolve();
        }

        if (!this.isRunning) {
            return this.start(options);
        }

        if (this.queued) {
            this.queued.options = { showLoading: this.queued.options.showLoading || options.showLoading };
            return this.queued.promise;
        }

        const queued = { options, resolve: null, promise: null };
        queued.promise = new Promise((resolve) => {
            queued.resolve = resolve;
        });
        this.queued = queued;
        return queued.promise;
    }

    /** Drops the queued rerun and ignores later requests (the room changed or unmounted). */
    stop() {
        this.isStopped = true;
        this.releaseQueued();
    }

    async start(options) {
        this.isRunning = true;
        try {
            await this.runFetch(options);
        } finally {
            this.isRunning = false;
            this.startQueued();
        }
    }

    startQueued() {
        if (!this.queued || this.isStopped) {
            this.releaseQueued();
            return;
        }

        const { options, resolve } = this.queued;
        this.queued = null;
        resolve(this.start(options));
    }

    /** Settles a dropped rerun's waiters so `await refetch()` never hangs. */
    releaseQueued() {
        if (this.queued) {
            this.queued.resolve();
            this.queued = null;
        }
    }
}
