import crypto from 'node:crypto';
import { normaliseName } from '../auth.js';
import { DEFAULT_GAME_MODE, isKnownGameMode } from '../../../shared/rules.js';
import { roomGameMode } from '../gameModes.js';
import { newPlayerFields } from './players.js';
import {
    CHAT_MESSAGE,
    OPEN_STATUSES,
    PLAYER,
    ROOM,
    ROUND_SCORE,
    ActionError,
    badRequest,
    createChild,
    deleteChild,
    deleteRoomRecord,
    flushRoom,
    insertRoom,
    listPlayers,
    listRoomChildren,
    updateChild,
    updateRoom,
} from './roomTx.js';

// Room actions: create, set-game-mode, start, close, delete, plus the by-code lookup.

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

// --- Room codes ----------------------------------------------------------

function randomCode() {
    let code = '';
    for (let index = 0; index < CODE_LENGTH; index++) {
        code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    return code;
}

/** Rooms with this code that aren't closed, newest last. */
function findOpenRoomsByCode(store, code) {
    const rooms = store.findRecords(ROOM, 'code', code);
    return rooms.filter((room) => room.status !== 'closed');
}

/** A code no open room uses. Runs inside the create transaction, so it can't race. */
function generateUniqueCode(store) {
    for (;;) {
        const code = randomCode();
        if (findOpenRoomsByCode(store, code).length === 0) {
            return code;
        }
    }
}

// --- Create --------------------------------------------------------------

function requireMaxScore(body) {
    const maxScore = body.max_score;
    if (!Number.isInteger(maxScore) || maxScore < 1) {
        throw badRequest('max_score must be a positive integer');
    }
    return maxScore;
}

function requireGameMode(mode) {
    if (!isKnownGameMode(mode)) {
        throw badRequest('game_mode is not a game mode');
    }
    return mode;
}

/** The mode a new room starts in: the body's, or classic when it doesn't say. */
function modeForNewRoom(body) {
    if (body.game_mode === undefined) {
        return DEFAULT_GAME_MODE;
    }
    return requireGameMode(body.game_mode);
}

/** name from the body, else the user's full_name, else the email's local part. */
function hostName(body, user) {
    const name = normaliseName(body.name) || normaliseName(user.full_name);
    if (name) {
        return name;
    }
    return user.email.split('@')[0];
}

/** Body of POST /api/rooms (runRoomAction with roomId null). */
export function createRoom(tx, body) {
    const maxScore = requireMaxScore(body);
    const gameMode = modeForNewRoom(body);
    const name = hostName(body, tx.user);

    const room = insertRoom(tx, {
        code: generateUniqueCode(tx.store),
        status: 'waiting',
        host_email: tx.user.email,
        host_player_id: null,
        max_score: maxScore,
        game_mode: gameMode,
        current_round: 1,
        current_turn_player_id: null,
        // The round whose turn a departing dealer already passed on (X20).
        turn_passed_round: null,
        is_edit_mode: false,
        edit_mode_by: null,
        winner_player_id: null,
        finish_reason: null,
        // Counts the games played in this room; play-again adds one (X5).
        game_number: 1,
    });
    const player = createChild(tx, PLAYER, newPlayerFields(room, tx.user.email, name, 0, true));
    updateRoom(tx, { host_player_id: player.id });
    return { player };
}

// --- Game mode -----------------------------------------------------------

/**
 * Every RoundScore was scored under the room's current mode, so the mode locks at the first one,
 * whichever action made it. A finished game has to go through Play Again first.
 */
function isModeLocked(tx) {
    return tx.room.status === 'finished' || listRoomChildren(tx, ROUND_SCORE).length > 0;
}

function setGameMode(tx, body) {
    const gameMode = requireGameMode(body.game_mode);

    // Before the lock check, so a retry after a lost response isn't reported as a failure.
    if (gameMode === roomGameMode(tx.room)) {
        return;
    }

    if (isModeLocked(tx)) {
        throw new ActionError(409, 'mode_locked', 'The game mode can\'t change once someone has scored');
    }
    updateRoom(tx, { game_mode: gameMode });
}

// --- Start ---------------------------------------------------------------

/** Deletes every RoundScore and zeroes every player, as start and play-again need. */
export function resetPlayersForNewGame(tx) {
    for (const score of listRoomChildren(tx, ROUND_SCORE)) {
        deleteChild(tx, ROUND_SCORE, score);
    }
    for (const player of listPlayers(tx)) {
        updateChild(tx, PLAYER, player, {
            total_score: 0,
            current_round_score: 0,
            has_submitted_round: false,
        });
    }
}

function start(tx) {
    // Only reachable for an admin acting on a room whose players were all
    // removed through the generic entity API; a game needs a first turn.
    const firstPlayer = listPlayers(tx)[0];
    if (!firstPlayer) {
        throw badRequest('The room has no players');
    }

    // Children are reset first; their events also go out before the room's
    // `playing` update, so no client sees old totals in a playing room (bug 4.7).
    resetPlayersForNewGame(tx);

    updateRoom(tx, {
        current_round: 1,
        current_turn_player_id: firstPlayer.id,
        turn_passed_round: null,
        winner_player_id: null,
        finish_reason: null,
        status: 'playing',
    });
}

// --- Close and delete ----------------------------------------------------

function close(tx) {
    updateRoom(tx, { status: 'closed' });
}

/**
 * Closes the room, then deletes its ChatMessages, RoundScores, Players and
 * the room itself. The `closed` update is published first, so clients learn
 * the room is gone even if they miss the deletes (bug 3.4).
 */
export function deleteRoomCascade(tx) {
    updateRoom(tx, { status: 'closed' });
    flushRoom(tx);

    for (const entity of [CHAT_MESSAGE, ROUND_SCORE, PLAYER]) {
        for (const record of listRoomChildren(tx, entity)) {
            deleteChild(tx, entity, record);
        }
    }
    deleteRoomRecord(tx);
}

export const setGameModeAction = { access: 'host', allowedStatuses: OPEN_STATUSES, run: setGameMode };
export const startAction = { access: 'host', allowedStatuses: ['waiting'], run: start };
export const closeAction = { access: 'host', allowedStatuses: null, run: close };
export const deleteAction = { access: 'host', allowedStatuses: null, run: deleteRoomCascade };

// --- Lookup by code ------------------------------------------------------

/** The room without the email-bearing fields, for callers who may not be members. */
function publicRoom(room) {
    const visible = { ...room };
    delete visible.host_email;
    delete visible.created_by;
    return visible;
}

function publicPlayer(player) {
    return { id: player.id, name: player.name, turn_order: player.turn_order, is_host: player.is_host };
}

/**
 * GET /api/rooms/by-code/:code for the join screen. Returns { status, body }:
 * the newest open room with that code, its players' names only, and the
 * caller's own Player (or null).
 */
export function lookupRoomByCode(store, user, rawCode) {
    const code = String(rawCode).trim().toUpperCase();
    const rooms = findOpenRoomsByCode(store, code);
    if (rooms.length === 0) {
        const error = new ActionError(404, 'room_not_found', 'Room not found');
        return { status: error.status, body: error.toBody() };
    }

    const room = rooms[rooms.length - 1];
    const players = store.findRecords(PLAYER, 'room_id', room.id);
    players.sort((left, right) => left.turn_order - right.turn_order);
    const myPlayer = players.find((player) => player.email === user.email) || null;

    return {
        status: 200,
        body: { room: publicRoom(room), players: players.map(publicPlayer), my_player: myPlayer },
    };
}
