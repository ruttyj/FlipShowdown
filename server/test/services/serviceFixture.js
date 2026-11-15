import assert from 'node:assert/strict';
import { PLAYER, ROOM, ROUND_SCORE } from '../../src/domain/entities.js';
import { ActionError } from '../../src/domain/errors.js';
import { createUnitOfWork, openTempStore, seedRoom } from '../actions/roomFixture.js';

// Shared setup for the services/ unit tests (this file contains no tests of its own): a room on a
// real store, units of work on it, and helpers to read and seed its records.

export { GUEST, HOST, OUTSIDER } from '../actions/roomFixture.js';

/** Starting game fields for a seeded Player, which seedRoom leaves out. */
const PLAYER_START = { total_score: 0, current_round_score: 0, has_submitted_round: false, games_won: 0 };

/** A Flip 7 hand: seven different number cards. */
export const FLIP7_CARDS = ['1', '2', '3', '4', '5', '6', '7'].map((value) => ({ value, type: 'number' }));

/** A parsed score as the handlers pass it to ScoringService, worth `finalScore`. */
export function scoreOf(finalScore, fields = {}) {
    return {
        cards: [{ value: String(finalScore), type: 'number' }],
        base_sum: finalScore,
        final_score: finalScore,
        busted: false,
        duplicate_allowed: false,
        flip7_attack_player_id: null,
        ...fields,
    };
}

/** Asserts that `action` throws an ActionError with this status and code; returns the error. */
export function assertActionError(action, status, code) {
    let thrown = null;
    assert.throws(action, (error) => {
        assert.ok(error instanceof ActionError, `expected an ActionError, got ${error}`);
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        thrown = error;
        return true;
    });
    return thrown;
}

/**
 * A room on a fresh temp store, `playing` round 1 in classic unless `roomFields` says otherwise,
 * hosted by HOST with GUEST seated first in turn order (see seedRoom). Returns helpers over it;
 * call `close()` when done.
 */
export function openRoom(roomFields = {}) {
    const temp = openTempStore();
    const store = temp.store;
    const seeded = seedRoom(store, { status: 'playing', current_round: 1, game_mode: 'classic', ...roomFields });
    const roomId = seeded.room.id;
    for (const player of [seeded.host, seeded.guest]) {
        store.updateRecord(PLAYER, player.id, PLAYER_START);
    }

    return {
        store,
        roomId,
        hostId: seeded.host.id,
        guestId: seeded.guest.id,
        close: temp.close,

        /** A RoomUnitOfWork for `user` with the room loaded. */
        workFor(user, { isAdmin = false } = {}) {
            const work = createUnitOfWork(store, user, isAdmin);
            work.loadRoom(roomId);
            return work;
        },

        room() {
            return store.getRecord(ROOM, roomId);
        },

        player(playerId) {
            return store.getRecord(PLAYER, playerId);
        },

        updatePlayer(playerId, changes) {
            return store.updateRecord(PLAYER, playerId, changes);
        },

        updateRoom(changes) {
            return store.updateRecord(ROOM, roomId, changes);
        },

        addPlayer(fields) {
            const [player] = store.createRecords(PLAYER, [{ room_id: roomId, ...PLAYER_START, ...fields }], 'host@example.com');
            return player;
        },

        /** Stores a RoundScore for the player directly, bypassing the services. */
        addScore(playerId, roundNumber, fields) {
            const record = { room_id: roomId, player_id: playerId, round_number: roundNumber, ...fields };
            const [score] = store.createRecords(ROUND_SCORE, [record], 'host@example.com');
            return score;
        },

        scores() {
            return store.findRecords(ROUND_SCORE, 'room_id', roomId);
        },
    };
}
