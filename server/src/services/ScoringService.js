import { isFlip7Hand, modeCapabilities } from '../../../shared/rules.js';
import { roomGameMode } from '../config/gameModes.js';
import { PLAYER, ROUND_SCORE } from '../domain/entities.js';
import { ActionError, badRequest } from '../domain/errors.js';
// TODO(P3.3): these are the room and player groups' rules; call RoomService and PlayerService
// instead once they exist.
// eslint-disable-next-line no-restricted-imports -- temporary cross-group import, see above
import { clearEditMode } from '../gameActions/players.js';
// eslint-disable-next-line no-restricted-imports -- temporary cross-group import, see above
import { resetPlayersForNewGame } from '../gameActions/rooms.js';

// Scoring and game flow: submit, retract and edit scores, Flip 7 attacks, force next round, edit
// mode, end, reopen, play again and games won. Stateless: every method takes the action's
// RoomUnitOfWork and arguments the action handler has already parsed from the request body.
//
// A score, as the handlers parse it, is { cards, base_sum, final_score, busted, duplicate_allowed,
// flip7_attack_player_id } (see actions/scoring/scoreBody.js).

// --- Checks on the room --------------------------------------------------

/**
 * The client scores a hand and the server trusts it, so a score worked out under another mode would
 * be wrong. This closes the gap of a host switching while someone has entry open: the client
 * refetches, re-scores and keeps the cards. An undefined `gameMode` (the body left it out) isn't
 * checked. The mode is never stored, as every score in a room is under the room's mode.
 */
function requireCurrentMode(room, gameMode) {
    if (gameMode === undefined) {
        return;
    }

    const roomMode = roomGameMode(room);
    if (gameMode !== roomMode) {
        throw new ActionError(409, 'mode_changed', 'The game mode has changed', { game_mode: roomMode });
    }
}

/**
 * Brutal's Flip 7 choice (X43), on a score about to be stored for `player`: another player in the
 * room, on a real Flip 7. A busted or already-submitted target is fine. Not run for a retry of a
 * closed round's score, as the target may have left since it was accepted.
 */
function requireValidAttack(work, player, score) {
    const targetId = score.flip7_attack_player_id;
    if (targetId === null) {
        return;
    }

    if (!modeCapabilities(roomGameMode(work.room)).hasFlip7Attack) {
        throw badRequest('Only a Brutal game has Flip 7 attacks');
    }
    if (score.busted || !isFlip7Hand(score.cards, { duplicateAllowed: score.duplicate_allowed })) {
        throw badRequest('Only a Flip 7 hand can attack');
    }
    const isOtherPlayer = targetId !== player.id && work.listPlayers().some((candidate) => candidate.id === targetId);
    if (!isOtherPlayer) {
        throw badRequest('flip7_attack_player_id must be another player in the room');
    }
}

/** edit-score reaches any round played so far, but not one that hasn't started. */
export function requireEditableRound(room, roundNumber) {
    if (roundNumber > room.current_round) {
        throw badRequest('round_number must be between 1 and the current round');
    }
}

function requireCurrentRound(room, roundNumber) {
    if (roundNumber !== room.current_round) {
        throw new ActionError(409, 'round_mismatch', 'That round is over', {
            current_round: room.current_round,
        });
    }
}

function roundOverError(room, storedScore) {
    return new ActionError(409, 'round_mismatch', 'That round is over', {
        current_round: room.current_round,
        stored_score: storedScore,
    });
}

// --- Comparing scores ----------------------------------------------------

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

// --- RoundScores ---------------------------------------------------------

/** The player's RoundScore for `roundNumber`, or null. */
function findRoundScore(work, player, roundNumber) {
    const scores = work.listRoomChildren(ROUND_SCORE);
    const found = scores.find((score) => score.player_id === player.id && score.round_number === roundNumber);
    return found || null;
}

/** Creates or replaces the player's one RoundScore for `roundNumber`. */
function upsertRoundScore(work, player, roundNumber, score) {
    const existing = findRoundScore(work, player, roundNumber);
    if (existing) {
        return work.updateChild(ROUND_SCORE, existing, score);
    }
    return work.createChild(ROUND_SCORE, {
        room_id: work.room.id,
        player_id: player.id,
        round_number: roundNumber,
        ...score,
    });
}

const ZERO_SCORE = { cards: [], base_sum: 0, final_score: 0 };

// --- After the game ------------------------------------------------------

/**
 * A round can finish with force-next-round's zeros stored and those players never marked submitted,
 * as the round was over. Back in play they count as submitted, or they would hold the round for a
 * score they already have.
 */
function markScoredPlayersSubmitted(work) {
    const roundNumber = work.room.current_round;
    for (const player of work.listRoomChildren(PLAYER)) {
        if (findRoundScore(work, player, roundNumber)) {
            work.updateChild(PLAYER, player, { has_submitted_round: true });
        }
    }
}

/** Only a max_score finish added a win (see RoundService#finishGame). The winner may have left since. */
function takeBackWin(work) {
    if (work.room.finish_reason !== 'max_score') {
        return;
    }

    const players = work.listRoomChildren(PLAYER);
    const winner = players.find((player) => player.id === work.room.winner_player_id);
    if (winner) {
        work.updateChild(PLAYER, winner, { games_won: Math.max(0, (winner.games_won ?? 0) - 1) });
    }
}

/** The room changes that turn edit mode on. An admin acting without a Player has no owner to name. */
function editModeOnChanges(work) {
    const callerPlayer = work.findCallerPlayer();
    return { is_edit_mode: true, edit_mode_by: callerPlayer ? callerPlayer.id : null };
}

/** The room's game_number. Rooms created before the field existed are on game 1. */
function currentGameNumber(room) {
    if (Number.isInteger(room.game_number)) {
        return room.game_number;
    }
    return 1;
}

// --- Service -------------------------------------------------------------

export class ScoringService {
    /** `roundService` is a RoundService and `totalsService` a TotalsService. */
    constructor({ roundService, totalsService }) {
        this.rounds = roundService;
        this.totals = totalsService;
    }

    // --- Recording a score -----------------------------------------------

    /**
     * Stores the score, recomputes the total and, for the current round, marks the player
     * submitted. A replaced score may have attacked someone else than this one does, so both
     * targets are recomputed too (X43). Returns the stored RoundScore.
     */
    #recordScore(work, player, roundNumber, score) {
        const previousTargetId = findRoundScore(work, player, roundNumber)?.flip7_attack_player_id;
        const roundScore = upsertRoundScore(work, player, roundNumber, score);
        const updated = this.totals.recomputeTotal(work, player);
        this.totals.recomputeAttackTarget(work, previousTargetId);
        this.totals.recomputeAttackTarget(work, score.flip7_attack_player_id);

        if (roundNumber === work.room.current_round) {
            work.updateChild(PLAYER, updated, {
                has_submitted_round: true,
                current_round_score: score.final_score,
            });
        }
        return roundScore;
    }

    /**
     * The caller's score for `roundNumber`, where `gameMode` is the mode the client scored it under
     * (undefined when not sent). For the current round it is stored and the round check runs. For
     * another round, a retry whose score is already stored there is reported as applied and anything
     * else is a round_mismatch carrying the stored score, so the client can tell the two apart.
     * Returns { already_applied, round_score }.
     */
    submitScore(work, { roundNumber, score, gameMode }) {
        requireCurrentMode(work.room, gameMode);
        const player = work.findCallerPlayer();

        if (roundNumber !== work.room.current_round) {
            const stored = findRoundScore(work, player, roundNumber);
            if (stored && isSameScore(stored, score)) {
                return { already_applied: true, round_score: stored };
            }
            throw roundOverError(work.room, stored);
        }

        requireValidAttack(work, player, score);
        const roundScore = this.#recordScore(work, player, roundNumber, score);
        this.rounds.runRoundCheck(work);
        return { already_applied: false, round_score: roundScore };
    }

    /**
     * Takes the caller's own score for the open round back, so they can undo a bust or change it.
     * Only the open round: a closed round's totals can't move under everyone, so that goes through
     * the host. It runs no round check, as taking a score away can't complete a round. A retry after
     * a lost response finds nothing stored, and changes nothing. Returns
     * { already_applied, round_score }, where round_score is what was deleted.
     */
    retractScore(work, roundNumber) {
        const player = work.findCallerPlayer();
        const stored = findRoundScore(work, player, roundNumber);

        if (roundNumber !== work.room.current_round) {
            throw roundOverError(work.room, stored);
        }
        if (!stored) {
            return { already_applied: true, round_score: null };
        }

        work.deleteChild(ROUND_SCORE, stored);
        const updated = this.totals.recomputeTotal(work, player);
        this.totals.recomputeAttackTarget(work, stored.flip7_attack_player_id);
        work.updateChild(PLAYER, updated, { has_submitted_round: false, current_round_score: 0 });
        return { already_applied: false, round_score: stored };
    }

    /**
     * The host's correction of `player`'s score for `roundNumber`, which the handler has checked is
     * a round played so far (requireEditableRound). Runs the round check, which does nothing while
     * edit mode is on. Returns { round_score }.
     */
    editScore(work, { player, roundNumber, score, gameMode }) {
        requireCurrentMode(work.room, gameMode);
        requireValidAttack(work, player, score);

        const roundScore = this.#recordScore(work, player, roundNumber, score);
        this.rounds.runRoundCheck(work);
        return { round_score: roundScore };
    }

    // --- Host round controls ---------------------------------------------

    /**
     * Gives every unsubmitted player a 0 RoundScore, ends edit mode and advances. A player who
     * already has a score for the round keeps it. The round_number check makes a second press (or a
     * second device) a 409.
     */
    forceNextRound(work, roundNumber) {
        requireCurrentRound(work.room, roundNumber);

        for (const player of work.listRoomChildren(PLAYER)) {
            const needsZeroScore = !player.has_submitted_round && !findRoundScore(work, player, roundNumber);
            if (needsZeroScore) {
                upsertRoundScore(work, player, roundNumber, ZERO_SCORE);
            }
        }

        clearEditMode(work);
        this.rounds.advanceRound(work);
    }

    /** Turns edit mode on, owned by the caller, or off, which runs the round check. */
    setEditMode(work, on) {
        if (!on) {
            clearEditMode(work);
            this.rounds.runRoundCheck(work);
            return;
        }

        work.updateRoom(editModeOnChanges(work));
    }

    endGame(work) {
        this.rounds.finishGame(work, 'ended');
    }

    // --- After the game --------------------------------------------------

    /**
     * Undoes a finish for when the last score was wrong, which edit-score can't reach as it only
     * runs while playing. Done Editing then runs the normal round check, so the game finishes again
     * or carries on, and exactly one win is counted. Scores and the round aren't touched, as
     * finishing doesn't touch them either.
     */
    reopenGame(work) {
        takeBackWin(work);
        markScoredPlayersSubmitted(work);
        work.updateRoom({
            status: 'playing',
            winner_player_id: null,
            finish_reason: null,
            ...editModeOnChanges(work),
        });
    }

    playAgain(work) {
        // Children first, so no client sees a waiting room with old totals.
        resetPlayersForNewGame(work);
        work.updateRoom({
            status: 'waiting',
            game_number: currentGameNumber(work.room) + 1,
            current_round: 1,
            current_turn_player_id: null,
            turn_passed_round: null,
            is_edit_mode: false,
            edit_mode_by: null,
            winner_player_id: null,
            finish_reason: null,
        });
    }

    /** `wins` is { player_id: games_won }, each an integer of 0 or more. */
    setGamesWon(work, wins) {
        // An unknown id throws player_not_found, which rolls back the earlier writes.
        for (const [playerId, gamesWon] of Object.entries(wins)) {
            work.updateChild(PLAYER, work.getRoomPlayer(playerId), { games_won: gamesWon });
        }
    }
}
