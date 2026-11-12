import { normaliseName } from '../auth.js';
import {
    OPEN_STATUSES,
    PLAYER,
    ROUND_SCORE,
    ActionError,
    badRequest,
    checkStatus,
    createChild,
    deleteChild,
    findCallerPlayer,
    getRoomPlayer,
    isHostPlayer,
    listPlayers,
    listRoomChildren,
    updateChild,
    updateRoom,
} from './roomTx.js';
import { runRoundCheck } from './rounds.js';
import { recomputeAttackTarget } from './totals.js';

// Player actions: join, leave, kick, make-host, reorder. Each export ending
// in "Action" is { access, allowedStatuses, run(tx, body) } for runRoomAction.

// --- Field defaults ------------------------------------------------------

/** A new Player with every game field at its starting value. */
export function newPlayerFields(room, email, name, turnOrder, isHost) {
    return {
        room_id: room.id,
        email,
        name,
        is_host: isHost,
        turn_order: turnOrder,
        total_score: 0,
        current_round_score: 0,
        has_submitted_round: false,
        games_won: 0,
        last_seen: null,
    };
}

// --- Turn order and hosting ----------------------------------------------

/**
 * The player after `player` in `orderedPlayers` (sorted by turn_order),
 * wrapping around. Null when `player` is the only one.
 */
export function nextPlayerAfter(orderedPlayers, player) {
    const others = orderedPlayers.filter((candidate) => candidate.id !== player.id);
    if (others.length === 0) {
        return null;
    }

    const later = others.find((candidate) => candidate.turn_order > player.turn_order);
    return later || others[0];
}

/**
 * True when the turn has already been passed to the next round's dealer: a
 * dealer left a complete round, so the round's rotation must not move the
 * turn on again (X4, X20). Set by removePlayer; the marker is a round number
 * so it goes stale by itself once the round advances, and the advance,
 * play-again and start also clear it. A finish keeps it for reopen-game.
 */
export function isTurnPassed(room) {
    return room.turn_passed_round === room.current_round;
}

/**
 * Whether the current round has been played out, once the dealer is gone. A max_score finish always
 * completed its round, even when Force Next Round's zeros left players unmarked. A waiting room has
 * no round to complete, and an ended game only did if everyone had submitted.
 */
function isRoundComplete(tx) {
    const { status, finish_reason: finishReason } = tx.room;
    if (status === 'finished' && finishReason === 'max_score') {
        return true;
    }

    const remaining = listPlayers(tx);
    const everyoneSubmitted = remaining.every((player) => player.has_submitted_round === true);
    return status !== 'waiting' && everyoneSubmitted;
}

/**
 * Hands the turn to `next` after the dealer left. Mid-round, `next` deals
 * the rest of the round and the round then rotates as usual. When the round
 * is already complete, `next` deals the next round, so the turn is marked as
 * passed and the advance keeps it on `next`, whether it happens straight
 * away, after edit mode turns off, after a mid-game joiner submits (X4b,
 * X20) or after a finished game is reopened. A passed turn stays passed if
 * its new holder leaves too.
 */
function passTurnAfterDealerLeft(tx, next) {
    let turnPassedRound = null;
    if (isRoundComplete(tx) || isTurnPassed(tx.room)) {
        turnPassedRound = tx.room.current_round;
    }
    updateRoom(tx, { current_turn_player_id: next.id, turn_passed_round: turnPassedRound });
}

/** Turns edit mode off. Callers run the round check afterwards. */
export function clearEditMode(tx) {
    updateRoom(tx, { is_edit_mode: false, edit_mode_by: null });
}

/**
 * Makes `newHost` the host: moves host_email, host_player_id and is_host,
 * and turns edit mode off (a host change always ends edit mode). Callers
 * run the round check afterwards.
 */
export function setHost(tx, newHost) {
    for (const player of listPlayers(tx)) {
        updateChild(tx, PLAYER, player, { is_host: player.id === newHost.id });
    }
    updateRoom(tx, { host_email: newHost.email, host_player_id: newHost.id });
    clearEditMode(tx);
}

/**
 * Deletes `player` and their RoundScores, then applies the side effects:
 * anyone they attacked gets the 15 back (X43), the turn and hosting move to
 * the next player by turn order, edit mode ends if they had turned it on, a
 * departing winner is no longer named, and the last player leaving closes the
 * room. Callers run the round check afterwards, so it sees the settled totals.
 */
export function removePlayer(tx, player) {
    const next = nextPlayerAfter(listPlayers(tx), player);

    const attackedIds = [];
    for (const score of listRoomChildren(tx, ROUND_SCORE)) {
        if (score.player_id === player.id) {
            attackedIds.push(score.flip7_attack_player_id);
            deleteChild(tx, ROUND_SCORE, score);
        }
    }
    deleteChild(tx, PLAYER, player);

    for (const attackedId of attackedIds) {
        recomputeAttackTarget(tx, attackedId);
    }

    if (tx.room.winner_player_id === player.id) {
        updateRoom(tx, { winner_player_id: null });
    }
    if (!next) {
        updateRoom(tx, { status: 'closed' });
        return;
    }

    const wasDealing = tx.room.current_turn_player_id === player.id;
    if (wasDealing) {
        passTurnAfterDealerLeft(tx, next);
    }
    if (isHostPlayer(tx.room, player)) {
        setHost(tx, next);
    } else if (tx.room.edit_mode_by === player.id) {
        clearEditMode(tx);
    }
}

// --- Body validation -----------------------------------------------------

function requirePlayerId(body) {
    const playerId = body.player_id;
    if (typeof playerId !== 'string' || playerId === '') {
        throw badRequest('player_id must be a non-empty string');
    }
    return playerId;
}

/** True when `playerIds` names every player exactly once. */
function listsEveryPlayerOnce(players, playerIds) {
    const uniqueIds = new Set(playerIds);
    const hasDuplicates = uniqueIds.size !== playerIds.length;
    const hasWrongCount = playerIds.length !== players.length;
    if (hasDuplicates || hasWrongCount) {
        return false;
    }
    return players.every((player) => uniqueIds.has(player.id));
}

// --- Actions -------------------------------------------------------------

function join(tx, body) {
    const existing = findCallerPlayer(tx);
    if (existing) {
        return { player: existing, already_joined: true };
    }

    const name = normaliseName(body.name);
    if (!name) {
        throw badRequest('name must be a non-empty string');
    }

    const players = listPlayers(tx);
    let turnOrder = 0;
    if (players.length > 0) {
        turnOrder = players[players.length - 1].turn_order + 1;
    }

    const player = createChild(tx, PLAYER, newPlayerFields(tx.room, tx.user.email, name, turnOrder, false));
    return { player, already_joined: false };
}

function leave(tx) {
    // Checked here rather than through the 'member' access level and the
    // action's statuses, so that a retried leave gets the contract's
    // `player_not_found`, even after the last player left and closed the room.
    const player = findCallerPlayer(tx);
    if (!player) {
        throw new ActionError(404, 'player_not_found', 'You are not in this room');
    }
    checkStatus(tx, OPEN_STATUSES);

    removePlayer(tx, player);
    runRoundCheck(tx, tx.room);
}

function kick(tx, body) {
    const player = getRoomPlayer(tx, requirePlayerId(body));
    if (player.email === tx.user.email) {
        throw badRequest('You cannot kick yourself; use leave');
    }

    removePlayer(tx, player);
    runRoundCheck(tx, tx.room);
}

function makeHost(tx, body) {
    const newHost = getRoomPlayer(tx, requirePlayerId(body));
    const isAlreadyHost = tx.room.host_player_id === newHost.id && newHost.is_host === true;
    if (isAlreadyHost) {
        return;
    }

    setHost(tx, newHost);
    runRoundCheck(tx, tx.room);
}

function reorder(tx, body) {
    const playerIds = body.player_ids;
    const players = listPlayers(tx);
    const isListOfIds = Array.isArray(playerIds) && playerIds.every((id) => typeof id === 'string');
    if (!isListOfIds || !listsEveryPlayerOnce(players, playerIds)) {
        throw badRequest('player_ids must list every player in the room exactly once');
    }

    for (const player of players) {
        updateChild(tx, PLAYER, player, { turn_order: playerIds.indexOf(player.id) });
    }
}

export const joinAction = { access: 'signed_in', allowedStatuses: OPEN_STATUSES, run: join };
// leave checks the status itself (see leave).
export const leaveAction = { access: 'signed_in', allowedStatuses: null, run: leave };
export const kickAction = { access: 'host', allowedStatuses: OPEN_STATUSES, run: kick };
export const makeHostAction = { access: 'host', allowedStatuses: OPEN_STATUSES, run: makeHost };
export const reorderAction = { access: 'host', allowedStatuses: ['waiting'], run: reorder };
