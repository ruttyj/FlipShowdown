import { clearEditMode, isTurnPassed, nextPlayerAfter } from './players.js';
import { PLAYER, listPlayers, updateChild, updateRoom } from './roomTx.js';

// Round logic: the round check, advance and finish. These run inside the
// transaction of the action that made the last change, so a round advances
// (or a game finishes) exactly once however many devices are open.

// --- Finish --------------------------------------------------------------

/**
 * The player with the highest total. `orderedPlayers` is sorted by
 * turn_order, and only a strictly higher total replaces the current pick,
 * so ties go to the lower turn_order. Null when there are no players.
 */
function pickWinner(orderedPlayers) {
    let winner = null;
    for (const player of orderedPlayers) {
        if (!winner || player.total_score > winner.total_score) {
            winner = player;
        }
    }
    return winner;
}

/**
 * Finishes the game. `reason` is 'max_score' or 'ended'; only 'max_score'
 * adds a win. Callers make sure the room is `playing`, and a finished room
 * isn't `playing`, so a game is finished (and a win counted) once.
 * turn_passed_round stays as it is, because reopen-game goes back to this same round and the deal
 * still has to stay on the player the turn was passed to.
 */
export function finishGame(tx, reason) {
    const winner = pickWinner(listPlayers(tx));

    if (winner && reason === 'max_score') {
        updateChild(tx, PLAYER, winner, { games_won: (winner.games_won ?? 0) + 1 });
    }

    clearEditMode(tx);
    updateRoom(tx, {
        status: 'finished',
        finish_reason: reason,
        winner_player_id: winner ? winner.id : null,
    });
}

// --- Advance -------------------------------------------------------------

/**
 * Who deals the next round. Normally the player after the current one by
 * turn order, wrapping around; falls back to the first player when the
 * current turn is unset or no longer in the room, and stays put with one
 * player. When a departing dealer already passed the turn on for this round
 * (see removePlayer), the current turn holder deals instead.
 */
function nextTurnPlayer(room, orderedPlayers) {
    const current = orderedPlayers.find((player) => player.id === room.current_turn_player_id);
    if (!current) {
        return orderedPlayers[0];
    }
    if (isTurnPassed(room)) {
        return current;
    }
    return nextPlayerAfter(orderedPlayers, current) || current;
}

/**
 * Ends the current round: finishes the game if anyone has reached
 * max_score, otherwise starts the next round with the turn rotated.
 */
export function advanceRound(tx) {
    const players = listPlayers(tx);
    const someoneReachedMax = players.some((player) => player.total_score >= tx.room.max_score);
    if (someoneReachedMax) {
        finishGame(tx, 'max_score');
        return;
    }

    const nextDealerId = nextTurnPlayer(tx.room, players).id;

    for (const player of players) {
        updateChild(tx, PLAYER, player, { has_submitted_round: false, current_round_score: 0 });
    }
    updateRoom(tx, {
        current_round: tx.room.current_round + 1,
        current_turn_player_id: nextDealerId,
        turn_passed_round: null,
    });
}

// --- Round check ---------------------------------------------------------

/**
 * The contract's round check: if the room is `playing`, edit mode is off,
 * there is at least one player and every player has submitted, advance.
 * Called after submit-score, edit-score, edit mode turning off, leave and kick.
 * `tx` is the roomTx action context; `room` is tx.room.
 */
export function runRoundCheck(tx, room) {
    if (room.status !== 'playing' || room.is_edit_mode) {
        return;
    }

    const players = listPlayers(tx);
    const everyoneSubmitted = players.every((player) => player.has_submitted_round === true);
    if (players.length === 0 || !everyoneSubmitted) {
        return;
    }

    advanceRound(tx);
}
