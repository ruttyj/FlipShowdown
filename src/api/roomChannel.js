// A room's realtime traffic in the game's terms. RealtimeConnection keeps a socket alive and
// carries messages; this module turns them into what the hooks care about, and is where wire
// field names stop (see "Room channel" in docs/backend-contract.md).
//
// It also owns recovery. After every `ready` and `rooms-ok` the server may have forgotten or the
// client may have missed something, so each part puts itself right:
// - a joined room is told it is stale, so it refetches (also on `resync`);
// - an open ballot sends a hold that is still pressed again;
// - an entry that is still open announces itself again;
// - a watched list of who is entering is emptied, as the server only follows up if anyone is on it.

import { ENTRY_STATUS_HEARTBEAT_MS, SERVER_MESSAGE } from '../../shared/realtimeProtocol.js';
import { createSharedVoteStore } from '../lib/voteState.js';

const ROOM_ENTITIES = ['GameRoom', 'Player', 'RoundScore', 'ChatMessage'];

// --- Decoding ----------------------------------------------------------------

function decodeVote(message, receivedAt) {
    const holds = [];
    for (const hold of message.holds ?? []) {
        holds.push({ playerId: hold.player_id, option: hold.option });
    }

    let pending = null;
    if (message.pending) {
        pending = { option: message.pending.option, remainingMs: message.pending.remaining_ms };
    }

    return {
        eligible: message.eligible ?? [],
        holds,
        pending,
        unlocksInMs: message.unlocks_in_ms ?? 0,
        receivedAt,
    };
}

function decodePresencePlayers(message) {
    const players = [];
    for (const player of message.players ?? []) {
        players.push({ playerId: player.player_id, online: player.online, lastSeen: player.last_seen });
    }
    return players;
}

function decodeEntries(message) {
    const entries = [];
    for (const entry of message.entries ?? []) {
        entries.push({ playerId: entry.player_id, state: entry.state, round: entry.round });
    }
    return entries;
}

// --- Rooms -------------------------------------------------------------------

function runAll(offs) {
    for (const off of offs) {
        off();
    }
}

function joinRoom(connection, roomId, { onRecordChange, onPresence, onStale }) {
    connection.setRooms([roomId]);

    const offs = [];
    for (const entity of ROOM_ENTITIES) {
        const off = connection.subscribe(entity, (event, meta) => {
            onRecordChange(entity, event, { roomVersion: meta.room_version });
        });
        offs.push(off);
    }
    offs.push(connection.onPresence((message) => {
        if (message.room_id === roomId) {
            onPresence(decodePresencePlayers(message));
        }
    }));
    // `ready` and `rooms-ok` both mean "events after this are live", so a refetch now covers the
    // gap. After the first load this is the one rerun the contract requires: events between the
    // load and the subscription were never delivered.
    offs.push(connection.onReady(() => onStale()));
    offs.push(connection.onResync(() => onStale()));

    return () => {
        runAll(offs);
        connection.setRooms([]);
    };
}

// --- Votes -------------------------------------------------------------------

function deliverVoteOutcome(message, { onPassed, onError }) {
    if (message.type === SERVER_MESSAGE.VOTE_PASSED) {
        onPassed?.(message.option);
    } else if (message.type === SERVER_MESSAGE.VOTE_ERROR) {
        onError?.(message.code);
    }
}

function openBallot(connection, roomId, topic, callbacks) {
    let heldOption = null;

    const offOutcome = connection.onVote((message) => {
        if (message.room_id === roomId && message.topic === topic) {
            deliverVoteOutcome(message, callbacks);
        }
    });
    // The server forgot the hold when the old socket closed; the finger is still down.
    const offReady = connection.onReady(() => {
        if (heldOption !== null) {
            connection.voteHold(roomId, topic, heldOption);
        }
    });

    function hold(option) {
        heldOption = option;
        connection.voteHold(roomId, topic, option);
    }

    // Only sends a release if this ballot is holding, so closing one button's ballot can't cancel
    // a hold made through another button on the same topic.
    function release() {
        if (heldOption === null) {
            return;
        }

        heldOption = null;
        connection.voteRelease(roomId, topic);
    }

    function close() {
        offOutcome();
        offReady();
        release();
    }

    return { hold, release, close };
}

// --- Entering cards ----------------------------------------------------------

function startEntry(connection, roomId, round) {
    let state = null;
    let heartbeat = null;

    function send() {
        connection.entryStatus(roomId, state, round);
    }

    // A restart loses the status, and a socket that released its room (X26) had it ignored.
    const offReady = connection.onReady(() => {
        if (state !== null) {
            send();
        }
    });

    function announce(nextState) {
        state = nextState;
        clearInterval(heartbeat);
        send();
        heartbeat = setInterval(send, ENTRY_STATUS_HEARTBEAT_MS);
    }

    function close() {
        clearInterval(heartbeat);
        offReady();
        connection.entryStatus(roomId, null, round);
    }

    return { announce, close };
}

function watchEntering(connection, roomId, listener) {
    let entries = [];

    // My connection is the only proof that the list is current.
    function publish() {
        if (connection.getStatus() === 'live') {
            listener(entries);
        } else {
            listener([]);
        }
    }

    const offs = [
        connection.onEntryStatus((message) => {
            if (message.room_id === roomId) {
                entries = decodeEntries(message);
                publish();
            }
        }),
        connection.onReady(() => {
            entries = [];
            publish();
        }),
        connection.onStatus(publish),
    ];

    return () => runAll(offs);
}

// --- Channel -----------------------------------------------------------------

/**
 * @typedef {object} RoomChannel
 * @property {(roomId: string, handlers: {
 *     onRecordChange: (entity: string, event: object, meta: { roomVersion: number|null }) => void,
 *     onPresence: (players: { playerId: string, online: boolean, lastSeen: string|null }[]) => void,
 *     onStale: () => void,
 *   }) => () => void} joinRoom
 *   Subscribes this page to the room until the returned leave() is called. `onStale` means the
 *   local copy may have missed something and should be refetched.
 * @property {(roomId: string, topic: string) => object|null} getVote
 *   The latest vote state (see src/lib/voteState.js), kept for the whole page from the moment the
 *   channel exists, so a vote button that mounts mid-vote shows the current holds. Null until the
 *   first one arrives.
 * @property {(listener: () => void) => () => void} subscribeVotes
 *   listener() after any vote state changes. Fits useSyncExternalStore with getVote.
 * @property {(roomId: string, topic: string, callbacks?: {
 *     onPassed?: (option: string) => void,
 *     onError?: (code: string) => void,
 *   }) => { hold: (option: string) => void, release: () => void, close: () => void }} openBallot
 *   One player's hands on one vote. A hold still pressed survives a reconnect; close() releases it.
 * @property {(roomId: string, round: number) => {
 *     announce: (state: 'scanning'|'typing') => void,
 *     close: () => void,
 *   }} startEntry
 *   I am entering cards for this round. Once announced, the state is kept alive by a heartbeat and
 *   said again after a reconnect. close() tells the room I am done.
 * @property {(roomId: string, listener: (entries: { playerId: string, state: string, round: number }[]) => void) => () => void} watchEntering
 *   listener(entries) with who the server says is entering, and an empty list while my own
 *   connection is down.
 */

/**
 * @param {import('./realtime.js').RealtimeConnection} connection
 * @returns {RoomChannel}
 */
export function createRoomChannel(connection) {
    const votes = createSharedVoteStore();
    connection.onVote((message) => {
        if (message.type === SERVER_MESSAGE.VOTE) {
            votes.set(message.room_id, message.topic, decodeVote(message, Date.now()));
        }
    });

    return {
        joinRoom: (roomId, handlers) => joinRoom(connection, roomId, handlers),
        getVote: votes.get,
        subscribeVotes: votes.subscribe,
        openBallot: (roomId, topic, callbacks = {}) => openBallot(connection, roomId, topic, callbacks),
        startEntry: (roomId, round) => startEntry(connection, roomId, round),
        watchEntering: (roomId, listener) => watchEntering(connection, roomId, listener),
    };
}
