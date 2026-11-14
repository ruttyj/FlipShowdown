import crypto from 'node:crypto';
import { isKnownGameMode } from '../../../shared/rules.js';
import { roomGameMode } from '../config/gameModes.js';
import { CHAT_MESSAGE, PLAYER, ROUND_SCORE } from '../domain/entities.js';
import { ActionError, badRequest } from '../domain/errors.js';
import { normaliseName } from './auth.js';
import { newPlayerFields } from './PlayerService.js';

// The room's own rules: create, set the game mode, start, close and delete, plus the join screen's
// lookup by code. Stateless: every method that acts on a room takes the action's RoomUnitOfWork
// (`work`) and plain, already-validated arguments.

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

// --- Validation and naming -----------------------------------------------

/** The mode, or a 400 when it isn't one of the game modes. */
export function requireGameMode(mode) {
    if (!isKnownGameMode(mode)) {
        throw badRequest('game_mode is not a game mode');
    }
    return mode;
}

/** A random six-character room code, e.g. "K7PQ2M". The alphabet leaves out 0/O and 1/I. */
export function randomRoomCode() {
    let code = '';
    for (let index = 0; index < CODE_LENGTH; index++) {
        code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    return code;
}

/** The host's name: the one asked for, else the user's full_name, else the email's local part. */
function hostName(requestedName, user) {
    const name = requestedName || normaliseName(user.full_name);
    if (name) {
        return name;
    }
    return user.email.split('@')[0];
}

// --- Lookup views --------------------------------------------------------

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

// --- Service -------------------------------------------------------------

export class RoomService {
    /**
     * `roomRepository` is a RoomRepository (code lookups) and `playerRepository` a
     * PlayerRepository (the lookup's player list). `randomCode()` returns a candidate room code;
     * tests replace it to force a collision.
     */
    constructor({ roomRepository, playerRepository, randomCode = randomRoomCode }) {
        this.roomRepository = roomRepository;
        this.playerRepository = playerRepository;
        this.randomCode = randomCode;
    }

    // --- Codes -----------------------------------------------------------

    /** Rooms with this code that aren't closed, oldest first. */
    #findOpenRoomsByCode(code) {
        const rooms = this.roomRepository.findByCode(code);
        return rooms.filter((room) => room.status !== 'closed');
    }

    /**
     * A code no open room uses. Called inside the create action's transaction, so another create
     * can't take the code before this one inserts its room.
     */
    generateUniqueCode() {
        for (;;) {
            const code = this.randomCode();
            if (this.#findOpenRoomsByCode(code).length === 0) {
                return code;
            }
        }
    }

    // --- Create ----------------------------------------------------------

    /**
     * Creates a `waiting` room hosted by the caller, with the caller as its first Player.
     * `name` is the normalised name asked for, or null to fall back to the user's own.
     * Returns { player }: the host's new Player.
     */
    createRoom(work, { maxScore, gameMode, name }) {
        const playerName = hostName(name, work.user);

        const room = work.insertRoom({
            code: this.generateUniqueCode(),
            status: 'waiting',
            host_email: work.user.email,
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

        const fields = newPlayerFields(room, work.user.email, playerName, 0, true);
        const player = work.createChild(PLAYER, fields);
        work.updateRoom({ host_player_id: player.id });
        return { player };
    }

    // --- Game mode -------------------------------------------------------

    /**
     * Every RoundScore was scored under the room's current mode, so the mode locks at the first
     * one, whichever action made it. A finished game has to go through Play Again first.
     */
    #isModeLocked(work) {
        const isFinished = work.room.status === 'finished';
        return isFinished || work.listRoomChildren(ROUND_SCORE).length > 0;
    }

    /** Switches the room to `gameMode`, or a 409 `mode_locked` once the mode can't change. */
    setGameMode(work, gameMode) {
        // Before the lock check, so a retry after a lost response isn't reported as a failure.
        if (gameMode === roomGameMode(work.room)) {
            return;
        }

        if (this.#isModeLocked(work)) {
            throw new ActionError(409, 'mode_locked', 'The game mode can\'t change once someone has scored');
        }
        work.updateRoom({ game_mode: gameMode });
    }

    // --- Start -----------------------------------------------------------

    /** Deletes every RoundScore and zeroes every player, as start and play-again need. */
    resetPlayersForNewGame(work) {
        for (const score of work.listRoomChildren(ROUND_SCORE)) {
            work.deleteChild(ROUND_SCORE, score);
        }
        for (const player of work.listPlayers()) {
            work.updateChild(PLAYER, player, {
                total_score: 0,
                current_round_score: 0,
                has_submitted_round: false,
            });
        }
    }

    /** Starts the first game: round 1, the first player in turn order deals. */
    start(work) {
        // Only reachable for an admin acting on a room whose players were all
        // removed through the generic entity API; a game needs a first turn.
        const firstPlayer = work.listPlayers()[0];
        if (!firstPlayer) {
            throw badRequest('The room has no players');
        }

        // Children are reset first; their events also go out before the room's
        // `playing` update, so no client sees old totals in a playing room (bug 4.7).
        this.resetPlayersForNewGame(work);

        work.updateRoom({
            current_round: 1,
            current_turn_player_id: firstPlayer.id,
            turn_passed_round: null,
            winner_player_id: null,
            finish_reason: null,
            status: 'playing',
        });
    }

    // --- Close and delete ------------------------------------------------

    close(work) {
        work.updateRoom({ status: 'closed' });
    }

    /**
     * Closes the room, then deletes its ChatMessages, RoundScores, Players and the room itself.
     * The `closed` update is published first, so clients learn the room is gone even if they miss
     * the deletes (bug 3.4).
     */
    deleteRoom(work) {
        work.updateRoom({ status: 'closed' });
        work.flushRoom();

        for (const entity of [CHAT_MESSAGE, ROUND_SCORE, PLAYER]) {
            for (const record of work.listRoomChildren(entity)) {
                work.deleteChild(entity, record);
            }
        }
        work.deleteRoomRecord();
    }

    // --- Lookup by code --------------------------------------------------

    /**
     * For the join screen, which callers who aren't members see too: the newest open room with
     * this code (any case, surrounding spaces ignored), its players' public fields in turn order,
     * and the Player of the caller with `callerEmail`, or null. Returns
     * { room, players, my_player }, or throws a 404 `room_not_found`. Reads outside any
     * transaction; it writes nothing.
     */
    lookupByCode(callerEmail, rawCode) {
        const code = String(rawCode).trim().toUpperCase();
        const rooms = this.#findOpenRoomsByCode(code);
        if (rooms.length === 0) {
            throw new ActionError(404, 'room_not_found', 'Room not found');
        }

        const room = rooms[rooms.length - 1];
        const players = this.playerRepository.listByRoomInTurnOrder(room.id);
        const myPlayer = players.find((player) => player.email === callerEmail) || null;

        return { room: publicRoom(room), players: players.map(publicPlayer), my_player: myPlayer };
    }
}
