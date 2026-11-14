import { OPEN_STATUSES, PLAYER, ROUND_SCORE } from '../domain/entities.js';
import { ActionError, badRequest } from '../domain/errors.js';
import { isHostPlayer } from '../domain/players.js';

// Re-exported for the tests that import it from here; it lives in domain/players.js.
export { isHostPlayer };

// The player rules: joining, leaving, kicking, hosting, turn order and the seats the room's
// players sit in. Stateless: every method takes the action's RoomUnitOfWork (`work`, with its
// room loaded) and arguments the action handler has already parsed.

// --- Seats and turn order ------------------------------------------------

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

/**
 * Whether the current round has been played out, once the dealer is gone. A max_score finish always
 * completed its round, even when Force Next Round's zeros left players unmarked. A waiting room has
 * no round to complete, and an ended game only did if everyone had submitted.
 */
function isRoundComplete(work) {
    const { status, finish_reason: finishReason } = work.room;
    if (status === 'finished' && finishReason === 'max_score') {
        return true;
    }

    const remaining = work.listPlayers();
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
function passTurnAfterDealerLeft(work, next) {
    let turnPassedRound = null;
    if (isRoundComplete(work) || isTurnPassed(work.room)) {
        turnPassedRound = work.room.current_round;
    }
    work.updateRoom({ current_turn_player_id: next.id, turn_passed_round: turnPassedRound });
}

// --- Service -------------------------------------------------------------

export class PlayerService {
    /**
     * `roundService` is a RoundService (the round check, and clearing edit mode) and
     * `totalsService` a TotalsService (recomputing a Flip 7 attack's target).
     */
    constructor({ roundService, totalsService }) {
        this.roundService = roundService;
        this.totalsService = totalsService;
    }

    // --- Actions ---------------------------------------------------------

    /**
     * Seats the caller at the end of the turn order. `name` is the normalised name, or null when
     * the request had none; it is only required for a new player, so a retried join still gets
     * the caller's existing Player. Returns { player, already_joined }.
     */
    join(work, name) {
        const existing = work.findCallerPlayer();
        if (existing) {
            return { player: existing, already_joined: true };
        }
        if (!name) {
            throw badRequest('name must be a non-empty string');
        }

        const players = work.listPlayers();
        let turnOrder = 0;
        if (players.length > 0) {
            turnOrder = players[players.length - 1].turn_order + 1;
        }

        const player = work.createChild(PLAYER, newPlayerFields(work.room, work.user.email, name, turnOrder, false));
        return { player, already_joined: false };
    }

    /** Removes the caller's Player from the room. */
    leave(work) {
        // Checked here rather than through the 'member' access level and the
        // action's statuses, so that a retried leave gets the contract's
        // `player_not_found`, even after the last player left and closed the room.
        const player = work.findCallerPlayer();
        if (!player) {
            throw new ActionError(404, 'player_not_found', 'You are not in this room');
        }
        work.requireStatus(OPEN_STATUSES);

        this.removePlayer(work, player);
        this.roundService.runRoundCheck(work);
    }

    /** Removes another player from the room. The caller can't kick themselves. */
    kick(work, playerId) {
        const player = work.getRoomPlayer(playerId);
        if (player.email === work.user.email) {
            throw badRequest('You cannot kick yourself; use leave');
        }

        this.removePlayer(work, player);
        this.roundService.runRoundCheck(work);
    }

    /** Hands the host role to the player with this id. Nothing changes if they already host. */
    makeHost(work, playerId) {
        const newHost = work.getRoomPlayer(playerId);
        const isAlreadyHost = work.room.host_player_id === newHost.id && newHost.is_host === true;
        if (isAlreadyHost) {
            return;
        }

        this.setHost(work, newHost);
        this.roundService.runRoundCheck(work);
    }

    /** Sets the turn order to the order of `playerIds`, which must list every player exactly once. */
    reorder(work, playerIds) {
        const players = work.listPlayers();
        if (!listsEveryPlayerOnce(players, playerIds)) {
            throw badRequest('player_ids must list every player in the room exactly once');
        }

        for (const player of players) {
            work.updateChild(PLAYER, player, { turn_order: playerIds.indexOf(player.id) });
        }
    }

    // --- Shared with the other rules --------------------------------------

    /**
     * Makes `newHost` the host: moves host_email, host_player_id and is_host,
     * and turns edit mode off (a host change always ends edit mode). Callers
     * run the round check afterwards.
     */
    setHost(work, newHost) {
        for (const player of work.listPlayers()) {
            work.updateChild(PLAYER, player, { is_host: player.id === newHost.id });
        }
        work.updateRoom({ host_email: newHost.email, host_player_id: newHost.id });
        this.roundService.clearEditMode(work);
    }

    /**
     * Deletes `player` and their RoundScores, then applies the side effects:
     * anyone they attacked gets the 15 back (X43), the turn and hosting move to
     * the next player by turn order, edit mode ends if they had turned it on, a
     * departing winner is no longer named, and the last player leaving closes the
     * room. Callers run the round check afterwards, so it sees the settled totals.
     */
    removePlayer(work, player) {
        const next = nextPlayerAfter(work.listPlayers(), player);

        const attackedIds = [];
        for (const score of work.listRoomChildren(ROUND_SCORE)) {
            if (score.player_id === player.id) {
                attackedIds.push(score.flip7_attack_player_id);
                work.deleteChild(ROUND_SCORE, score);
            }
        }
        work.deleteChild(PLAYER, player);

        for (const attackedId of attackedIds) {
            this.totalsService.recomputeAttackTarget(work, attackedId);
        }

        if (work.room.winner_player_id === player.id) {
            work.updateRoom({ winner_player_id: null });
        }
        if (!next) {
            work.updateRoom({ status: 'closed' });
            return;
        }

        const wasDealing = work.room.current_turn_player_id === player.id;
        if (wasDealing) {
            passTurnAfterDealerLeft(work, next);
        }
        if (isHostPlayer(work.room, player)) {
            this.setHost(work, next);
        } else if (work.room.edit_mode_by === player.id) {
            this.roundService.clearEditMode(work);
        }
    }
}
