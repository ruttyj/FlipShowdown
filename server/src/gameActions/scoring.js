import { MAX_CARDS_PER_ROUND, isFlip7Hand, modeCapabilities } from '../../../shared/rules.js';
import { roomGameMode } from '../gameModes.js';
import { isPlainObject } from '../query.js';
import { resetPlayersForNewGame } from './rooms.js';
import { clearEditMode } from './players.js';
import {
    OPEN_STATUSES,
    PLAYER,
    ROUND_SCORE,
    ActionError,
    badRequest,
    createChild,
    deleteChild,
    findCallerPlayer,
    getRoomPlayer,
    listPlayers,
    listRoomChildren,
    updateChild,
    updateRoom,
} from './roomTx.js';
import { advanceRound, finishGame, runRoundCheck } from './rounds.js';
import { recomputeAttackTarget, recomputeTotal } from './totals.js';

// Scoring and game-flow actions: submit-score, retract-score, force-next-round,
// set-edit-mode, edit-score, end-game, reopen-game, play-again and
// set-games-won. Each export ending in "Action" is
// { access, allowedStatuses, run(tx, body) } for runRoomAction.

// Scores can be negative (X1: a negative number card), so they range over ±1000.
const MIN_SCORE_VALUE = -1000;
const MAX_SCORE_VALUE = 1000;

// --- Body validation -----------------------------------------------------

function requireBoolean(body, field) {
    const value = body[field];
    if (typeof value !== 'boolean') {
        throw badRequest(`${field} must be a boolean`);
    }
    return value;
}

/** A boolean that may be left out, which means false. */
function readOptionalBoolean(body, field) {
    if (body[field] === undefined) {
        return false;
    }
    return requireBoolean(body, field);
}

function requireRoundNumber(body) {
    const roundNumber = body.round_number;
    if (!Number.isInteger(roundNumber) || roundNumber < 1) {
        throw badRequest('round_number must be a positive integer');
    }
    return roundNumber;
}

function requirePlayerId(body) {
    const playerId = body.player_id;
    if (typeof playerId !== 'string' || playerId === '') {
        throw badRequest('player_id must be a non-empty string');
    }
    return playerId;
}

/** A player id that may be left out or null, which both mean no attack. */
function readAttackPlayerId(body) {
    const playerId = body.flip7_attack_player_id;
    if (playerId === undefined || playerId === null) {
        return null;
    }
    if (typeof playerId !== 'string' || playerId === '') {
        throw badRequest('flip7_attack_player_id must be a non-empty string or null');
    }
    return playerId;
}

function isScoreValue(value) {
    return Number.isInteger(value) && value >= MIN_SCORE_VALUE && value <= MAX_SCORE_VALUE;
}

function isCard(card) {
    return isPlainObject(card) && typeof card.value === 'string' && typeof card.type === 'string';
}

/**
 * The score fields of a submit or edit body, checked against the contract:
 * at most 30 `{value, type}` cards (other card fields are dropped),
 * base_sum and final_score integers from -1000 to 1000, and the optional
 * flags busted and duplicate_allowed and target flip7_attack_player_id. These
 * are always stored, so a replacing score that leaves one out doesn't keep the
 * old value. The target is only checked once the score is to be applied: see
 * requireValidAttack.
 */
function requireScore(body) {
    const cards = body.cards;
    const hasValidCards = Array.isArray(cards) && cards.length <= MAX_CARDS_PER_ROUND && cards.every(isCard);
    if (!hasValidCards) {
        throw badRequest(`cards must be an array of at most ${MAX_CARDS_PER_ROUND} {value, type} strings`);
    }
    if (!isScoreValue(body.base_sum) || !isScoreValue(body.final_score)) {
        throw badRequest(`base_sum and final_score must be integers from ${MIN_SCORE_VALUE} to ${MAX_SCORE_VALUE}`);
    }

    return {
        cards: cards.map((card) => ({ value: card.value, type: card.type })),
        base_sum: body.base_sum,
        final_score: body.final_score,
        busted: readOptionalBoolean(body, 'busted'),
        duplicate_allowed: readOptionalBoolean(body, 'duplicate_allowed'),
        flip7_attack_player_id: readAttackPlayerId(body),
    };
}

/**
 * The client scores a hand and the server trusts it, so a score worked out under another mode would
 * be wrong. This closes the gap of a host switching while someone has entry open: the client
 * refetches, re-scores and keeps the cards. A body without the field isn't checked. The mode is
 * never stored, as every score in a room is under the room's mode.
 */
function requireCurrentMode(tx, body) {
    if (body.game_mode === undefined) {
        return;
    }

    const roomMode = roomGameMode(tx.room);
    if (body.game_mode !== roomMode) {
        throw new ActionError(409, 'mode_changed', 'The game mode has changed', { game_mode: roomMode });
    }
}

/**
 * Brutal's Flip 7 choice (X43), on a score about to be stored for `player`: another player in the
 * room, on a real Flip 7. A busted or already-submitted target is fine. Not run for a retry of a
 * closed round's score, as the target may have left since it was accepted.
 */
function requireValidAttack(tx, player, score) {
    const targetId = score.flip7_attack_player_id;
    if (targetId === null) {
        return;
    }

    if (!modeCapabilities(roomGameMode(tx.room)).hasFlip7Attack) {
        throw badRequest('Only a Brutal game has Flip 7 attacks');
    }
    if (score.busted || !isFlip7Hand(score.cards, { duplicateAllowed: score.duplicate_allowed })) {
        throw badRequest('Only a Flip 7 hand can attack');
    }
    const isOtherPlayer = targetId !== player.id && listPlayers(tx).some((candidate) => candidate.id === targetId);
    if (!isOtherPlayer) {
        throw badRequest('flip7_attack_player_id must be another player in the room');
    }
}

/** { player_id: wins } with every wins an integer >= 0. */
function requireWins(body) {
    const wins = body.wins;
    if (!isPlainObject(wins)) {
        throw badRequest('wins must be an object of player_id to integer');
    }
    for (const value of Object.values(wins)) {
        if (!Number.isInteger(value) || value < 0) {
            throw badRequest('each wins value must be an integer of 0 or more');
        }
    }
    return wins;
}

// --- RoundScores and totals ----------------------------------------------

function scoresOf(tx, player) {
    const scores = listRoomChildren(tx, ROUND_SCORE);
    return scores.filter((score) => score.player_id === player.id);
}

/** The player's RoundScore for `roundNumber`, or null. */
function findRoundScore(tx, player, roundNumber) {
    const scores = scoresOf(tx, player);
    return scores.find((score) => score.round_number === roundNumber) || null;
}

/** Creates or replaces the player's one RoundScore for `roundNumber`. */
function upsertRoundScore(tx, player, roundNumber, score) {
    const existing = findRoundScore(tx, player, roundNumber);
    if (existing) {
        return updateChild(tx, ROUND_SCORE, existing, score);
    }
    return createChild(tx, ROUND_SCORE, {
        room_id: tx.room.id,
        player_id: player.id,
        round_number: roundNumber,
        ...score,
    });
}

/**
 * Stores the score, recomputes the total and, for the current round,
 * marks the player submitted. A replaced score may have attacked someone else
 * than this one does, so both targets are recomputed too (X43). Returns
 * { player, round_score }.
 */
function recordScore(tx, player, roundNumber, score) {
    const previousTargetId = findRoundScore(tx, player, roundNumber)?.flip7_attack_player_id;
    const roundScore = upsertRoundScore(tx, player, roundNumber, score);
    let updated = recomputeTotal(tx, player);
    recomputeAttackTarget(tx, previousTargetId);
    recomputeAttackTarget(tx, score.flip7_attack_player_id);

    if (roundNumber === tx.room.current_round) {
        updated = updateChild(tx, PLAYER, updated, {
            has_submitted_round: true,
            current_round_score: score.final_score,
        });
    }
    return { player: updated, round_score: roundScore };
}

// --- Submit score --------------------------------------------------------

/** Scores stored before these fields existed, and force-next-round zeros, read as false and null. */
function isSameScore(stored, score) {
    const isSameCards = JSON.stringify(stored.cards) === JSON.stringify(score.cards);
    return stored.final_score === score.final_score
        && stored.base_sum === score.base_sum
        && (stored.busted === true) === score.busted
        && (stored.duplicate_allowed === true) === score.duplicate_allowed
        && (stored.flip7_attack_player_id ?? null) === score.flip7_attack_player_id
        && isSameCards;
}

function roundOverError(tx, storedScore) {
    return new ActionError(409, 'round_mismatch', 'That round is over', {
        current_round: tx.room.current_round,
        stored_score: storedScore,
    });
}

/**
 * A submit for a round other than the current one. A retry whose score is
 * already stored for that round is reported as applied; anything else is a
 * round_mismatch carrying the stored score, so the client can tell the two apart.
 */
function answerStaleSubmit(tx, player, roundNumber, score) {
    const stored = findRoundScore(tx, player, roundNumber);
    if (stored && isSameScore(stored, score)) {
        return { already_applied: true, round_score: stored };
    }

    throw roundOverError(tx, stored);
}

function submitScore(tx, body) {
    const roundNumber = requireRoundNumber(body);
    const score = requireScore(body);
    requireCurrentMode(tx, body);
    const player = findCallerPlayer(tx);

    if (roundNumber !== tx.room.current_round) {
        return answerStaleSubmit(tx, player, roundNumber, score);
    }

    requireValidAttack(tx, player, score);
    const result = recordScore(tx, player, roundNumber, score);
    runRoundCheck(tx, tx.room);
    return { already_applied: false, round_score: result.round_score };
}

// --- Retract score -------------------------------------------------------

/**
 * Takes my own score for the open round back, so I can undo a bust or change it. Only the open
 * round: a closed round's totals can't move under everyone, so that goes through the host. It runs
 * no round check, as taking a score away can't complete a round. A retry after a lost response finds
 * nothing stored, and changes nothing.
 */
function retractScore(tx, body) {
    const roundNumber = requireRoundNumber(body);
    const player = findCallerPlayer(tx);
    const stored = findRoundScore(tx, player, roundNumber);

    if (roundNumber !== tx.room.current_round) {
        throw roundOverError(tx, stored);
    }
    if (!stored) {
        return { already_applied: true, round_score: null };
    }

    deleteChild(tx, ROUND_SCORE, stored);
    const updated = recomputeTotal(tx, player);
    recomputeAttackTarget(tx, stored.flip7_attack_player_id);
    updateChild(tx, PLAYER, updated, { has_submitted_round: false, current_round_score: 0 });
    return { already_applied: false, round_score: stored };
}

// --- Host round controls -------------------------------------------------

function requireCurrentRound(tx, roundNumber) {
    if (roundNumber !== tx.room.current_round) {
        throw new ActionError(409, 'round_mismatch', 'That round is over', {
            current_round: tx.room.current_round,
        });
    }
}

const ZERO_SCORE = { cards: [], base_sum: 0, final_score: 0 };

/**
 * Gives every unsubmitted player a 0 RoundScore, ends edit mode and
 * advances. A player who already has a score for the round keeps it.
 * The round_number check makes a second press (or a second device) a 409.
 */
function forceNextRound(tx, body) {
    requireCurrentRound(tx, requireRoundNumber(body));

    const roundNumber = tx.room.current_round;
    for (const player of listRoomChildren(tx, PLAYER)) {
        const needsZeroScore = !player.has_submitted_round && !findRoundScore(tx, player, roundNumber);
        if (needsZeroScore) {
            upsertRoundScore(tx, player, roundNumber, ZERO_SCORE);
        }
    }

    clearEditMode(tx);
    advanceRound(tx);
}

/** The room changes that turn edit mode on. An admin acting without a Player has no owner to name. */
function editModeOnChanges(tx) {
    const callerPlayer = findCallerPlayer(tx);
    return { is_edit_mode: true, edit_mode_by: callerPlayer ? callerPlayer.id : null };
}

function setEditMode(tx, body) {
    const on = requireBoolean(body, 'on');
    if (!on) {
        clearEditMode(tx);
        runRoundCheck(tx, tx.room);
        return;
    }

    updateRoom(tx, editModeOnChanges(tx));
}

function editScore(tx, body) {
    const player = getRoomPlayer(tx, requirePlayerId(body));
    const roundNumber = requireRoundNumber(body);
    if (roundNumber > tx.room.current_round) {
        throw badRequest('round_number must be between 1 and the current round');
    }
    const score = requireScore(body);
    requireCurrentMode(tx, body);
    requireValidAttack(tx, player, score);

    const result = recordScore(tx, player, roundNumber, score);
    runRoundCheck(tx, tx.room);
    return { round_score: result.round_score };
}

function endGame(tx) {
    finishGame(tx, 'ended');
}

// --- After the game ------------------------------------------------------

/** Only a max_score finish added a win (see finishGame). The winner may have left since. */
function takeBackWin(tx) {
    if (tx.room.finish_reason !== 'max_score') {
        return;
    }

    const players = listRoomChildren(tx, PLAYER);
    const winner = players.find((player) => player.id === tx.room.winner_player_id);
    if (winner) {
        updateChild(tx, PLAYER, winner, { games_won: Math.max(0, (winner.games_won ?? 0) - 1) });
    }
}

/**
 * A round can finish with force-next-round's zeros stored and those players never marked submitted,
 * as the round was over. Back in play they count as submitted, or they would hold the round for a
 * score they already have.
 */
function markScoredPlayersSubmitted(tx) {
    const roundNumber = tx.room.current_round;
    for (const player of listRoomChildren(tx, PLAYER)) {
        if (findRoundScore(tx, player, roundNumber)) {
            updateChild(tx, PLAYER, player, { has_submitted_round: true });
        }
    }
}

/**
 * Undoes a finish for when the last score was wrong, which edit-score can't reach as it only runs
 * while playing. Done Editing then runs the normal round check, so the game finishes again or carries
 * on, and exactly one win is counted. Scores and the round aren't touched, as finishing doesn't touch
 * them either.
 */
function reopenGame(tx) {
    takeBackWin(tx);
    markScoredPlayersSubmitted(tx);
    updateRoom(tx, {
        status: 'playing',
        winner_player_id: null,
        finish_reason: null,
        ...editModeOnChanges(tx),
    });
}

/** The room's game_number. Rooms created before the field existed are on game 1. */
function currentGameNumber(room) {
    if (Number.isInteger(room.game_number)) {
        return room.game_number;
    }
    return 1;
}

function playAgain(tx) {
    // Children first, so no client sees a waiting room with old totals.
    resetPlayersForNewGame(tx);
    updateRoom(tx, {
        status: 'waiting',
        game_number: currentGameNumber(tx.room) + 1,
        current_round: 1,
        current_turn_player_id: null,
        turn_passed_round: null,
        is_edit_mode: false,
        edit_mode_by: null,
        winner_player_id: null,
        finish_reason: null,
    });
}

function setGamesWon(tx, body) {
    const wins = requireWins(body);

    // An unknown id throws player_not_found, which rolls back the earlier writes.
    for (const [playerId, gamesWon] of Object.entries(wins)) {
        updateChild(tx, PLAYER, getRoomPlayer(tx, playerId), { games_won: gamesWon });
    }
}

export const submitScoreAction = { access: 'member', allowedStatuses: ['playing'], run: submitScore };
export const retractScoreAction = { access: 'member', allowedStatuses: ['playing'], run: retractScore };
export const forceNextRoundAction = { access: 'host', allowedStatuses: ['playing'], run: forceNextRound };
export const setEditModeAction = { access: 'host', allowedStatuses: ['playing'], run: setEditMode };
export const editScoreAction = { access: 'host', allowedStatuses: ['playing'], run: editScore };
export const endGameAction = { access: 'host', allowedStatuses: ['playing'], run: endGame };
export const reopenGameAction = { access: 'host', allowedStatuses: ['finished'], run: reopenGame };
export const playAgainAction = { access: 'host', allowedStatuses: ['finished'], run: playAgain };
export const setGamesWonAction = { access: 'host', allowedStatuses: OPEN_STATUSES, run: setGamesWon };
