// A real game room for client tests: the server's own action code running against SQLite in a temp
// directory, in this process and with no HTTP, the same way e2e/fixtures/server.js gives a browser a
// real server. Replies and conflicts are therefore what the server really says, never hand-typed.
//
// Nothing here knows about Vitest, so `node --test` can use it too. tests/ui/fixtures/testRoom.jsx
// plugs it into the fake API modules for hook and page tests.
//
//   const room = createServerRoom({ players: ['p1', 'p2'] })   // p1 hosts; the game has started
//   room.act('p2', 'submit-score', room.scoreBody(1))          // -> { status, body }
//   room.player('p2').has_submitted_round                      // true
//   room.close()                                               // required: deletes the temp dir
//
// A name is `<name>@example.com` when signed in. Ids are the server's, so ask room.player(name).id.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../server/src/config.js';
import { openStore } from '../../server/src/db.js';
import { ACTIONS } from '../../server/src/gameActions/index.js';
import { createRoom, lookupRoomByCode } from '../../server/src/gameActions/rooms.js';
import { runRoomAction } from '../../server/src/gameActions/roomTx.js';

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

export function emailOf(name) {
    return `${name}@example.com`;
}

function userOf(name) {
    return { id: `user-${name}`, email: emailOf(name), full_name: name };
}

// --- Events --------------------------------------------------------------

/**
 * Stands in for the realtime hub: an action's events reach the listeners in the shape a client's
 * subscribe callback gets them, `(entity, event, { room_version, seq })`. JSON round-tripped like
 * the socket does, so nothing shares an object with the database layer.
 */
function createEventHub() {
    const listeners = new Set();
    let seq = 0;

    return {
        listen(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        publishAll(events, { roomVersion } = {}) {
            for (const { entity, type, record } of events) {
                seq += 1;
                const event = JSON.parse(JSON.stringify({ type, id: record.id, data: record, timestamp: new Date().toISOString() }));
                for (const listener of [...listeners]) {
                    listener(entity, event, { room_version: roomVersion ?? null, seq });
                }
            }
        },
        roomMembershipChanged() {},
        roomHostChanged() {},
    };
}

// --- The room ------------------------------------------------------------

function toWire(result) {
    return { status: result.status, body: JSON.parse(JSON.stringify(result.body)) };
}

function mustSucceed(result, what) {
    if (result.status !== 200) {
        throw new Error(`serverRoom: ${what} answered ${result.status}: ${JSON.stringify(result.body)}`);
    }
    return result.body;
}

/**
 * @param {object} [options]
 * @param {string[]} [options.players]  names in turn order; the first is the host
 * @param {string} [options.gameMode]
 * @param {boolean} [options.start]  false leaves the room in `waiting`
 */
export function createServerRoom({ players = ['p1', 'p2'], gameMode = 'classic', start = true } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-room-'));
    const config = loadConfig({ AUTH_MODE: 'dev', SESSION_SECRET: 'test-secret', DATA_DIR: dataDir });
    const store = openStore(dataDir);
    const hub = createEventHub();
    const context = { config, store, hub, logger: silentLogger };

    const [hostName, ...guestNames] = players;
    const hostRequest = { user: userOf(hostName), roomId: null, access: 'signed_in', allowedStatuses: null };
    const created = mustSucceed(
        runRoomAction(context, hostRequest, (tx) => createRoom(tx, { max_score: 200, name: hostName, game_mode: gameMode })),
        'create room',
    );
    const roomId = created.room.id;
    const roomCode = created.room.code;

    const room = {
        id: roomId,
        code: roomCode,
        listen: hub.listen,

        /** Runs a game action as this player. @returns {{status: number, body: object}} */
        act(name, actionName, body = {}) {
            const action = ACTIONS[actionName];
            const request = { user: userOf(name), roomId, access: action.access, allowedStatuses: action.allowedStatuses };
            return toWire(runRoomAction(context, request, (tx) => action.run(tx, body)));
        },

        /** Runs an action that the scenario needs to succeed; returns the response body. */
        must(name, actionName, body = {}) {
            return mustSucceed(room.act(name, actionName, body), actionName);
        },

        /** @returns {{status: number, body: object}} the by-code lookup as this player */
        lookup(name) {
            return toWire(lookupRoomByCode(store, userOf(name), roomCode));
        },

        /** @returns {object[]} a generic member read, oldest first */
        records(entity) {
            if (entity === 'GameRoom') {
                return [room.record()];
            }
            return JSON.parse(JSON.stringify(store.findRecords(entity, 'room_id', roomId)));
        },

        record() {
            return JSON.parse(JSON.stringify(store.getRecord('GameRoom', roomId)));
        },

        player(name) {
            return room.records('Player').find((player) => player.email === emailOf(name));
        },

        /** A valid `submit-score` body worth 5 under the room's mode, for a player who just needs a score in. */
        scoreBody(roundNumber, overrides = {}) {
            return {
                round_number: roundNumber,
                cards: [{ value: '5', type: 'number' }],
                base_sum: 5,
                final_score: 5,
                ...overrides,
            };
        },

        /** Everyone scores, so the room moves on to the next round. */
        playRound() {
            const roundNumber = room.record().current_round;
            for (const name of players) {
                room.must(name, 'submit-score', room.scoreBody(roundNumber));
            }
        },

        close() {
            store.close();
            // SQLite can hold the file briefly after closing on Windows.
            fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        },
    };

    for (const name of guestNames) {
        room.must(name, 'join', { name });
    }
    if (start) {
        room.must(hostName, 'start');
    }
    return room;
}
