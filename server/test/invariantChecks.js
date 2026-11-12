// The B7 game invariants, checked by invariants.test.js after every step of
// the random driver (this file contains no tests of its own).
//
// Every check takes a `step`:
//   action   - the action name ('create' for the room's creation)
//   status   - the HTTP status the action answered
//   before   - the room snapshot before the action, or null for 'create'
//   after    - the room snapshot after the action
//   events   - the event-log rows the action added, as [{ seq, roomVersion }]
//   lastSeq  - the event log's last seq before the action
// A snapshot is { room, players, scores }, players sorted by turn_order.
// A check returns a one-line description of the violation, or null.

const MIN_FINAL_SCORE = -1000;
const MAX_FINAL_SCORE = 1000;
const FLIP7_ATTACK_POINTS = 15;

// --- Small helpers -------------------------------------------------------

function findPlayer(snapshot, playerId) {
    return snapshot.players.find((player) => player.id === playerId) || null;
}

function scoresOfPlayer(snapshot, playerId) {
    return snapshot.scores.filter((score) => score.player_id === playerId);
}

function hasScoreForRound(snapshot, playerId, roundNumber) {
    return scoresOfPlayer(snapshot, playerId).some((score) => score.round_number === roundNumber);
}

/** The first value that appears twice in `values`, or undefined. */
function findDuplicate(values) {
    const seen = new Set();
    for (const value of values) {
        if (seen.has(value)) {
            return value;
        }
        seen.add(value);
    }
    return undefined;
}

// --- Scores --------------------------------------------------------------

function checkTotals({ after }) {
    for (const player of after.players) {
        let sum = 0;
        for (const score of after.scores) {
            if (score.player_id === player.id) {
                sum += score.final_score;
            }
            if (score.flip7_attack_player_id === player.id) {
                sum -= FLIP7_ATTACK_POINTS;
            }
        }
        if (player.total_score !== sum) {
            return `${player.name} has total_score ${player.total_score} but their RoundScores and attacks sum to ${sum}`;
        }
    }
    return null;
}

function checkOneScorePerRound({ after }) {
    const keys = after.scores.map((score) => `${score.player_id} round ${score.round_number}`);
    const duplicate = findDuplicate(keys);
    if (duplicate !== undefined) {
        return `two RoundScores for player ${duplicate}`;
    }
    return null;
}

function checkFinalScoreRange({ after }) {
    for (const score of after.scores) {
        const value = score.final_score;
        const isInRange = Number.isInteger(value)
            && value >= MIN_FINAL_SCORE
            && value <= MAX_FINAL_SCORE;
        if (!isInRange) {
            return `RoundScore ${score.id} has final_score ${value}`;
        }
    }
    return null;
}

function checkSubmittedFlags({ after }) {
    if (after.room.status !== 'playing') {
        return null;
    }

    for (const player of after.players) {
        const hasScore = hasScoreForRound(after, player.id, after.room.current_round);
        if (player.has_submitted_round !== hasScore) {
            return `${player.name} has has_submitted_round ${player.has_submitted_round}`
                + ` but ${hasScore ? 'has' : 'has no'} RoundScore for round ${after.room.current_round}`;
        }
    }
    return null;
}

// --- Membership and hosting ----------------------------------------------

function checkSingleHost({ after }) {
    const { room, players } = after;
    const hosts = players.filter((player) => player.is_host === true);

    if (room.status === 'closed') {
        if (hosts.length > 0) {
            return `closed room still has ${hosts.length} host player(s)`;
        }
        return null;
    }
    if (players.length === 0) {
        return null;
    }

    if (hosts.length !== 1) {
        return `open room has ${hosts.length} players with is_host`;
    }
    const host = hosts[0];
    if (room.host_player_id !== host.id || room.host_email !== host.email) {
        return `is_host is on ${host.name} but the room names ${room.host_email} (${room.host_player_id})`;
    }
    return null;
}

function checkUniqueEmails({ after }) {
    const duplicate = findDuplicate(after.players.map((player) => player.email));
    if (duplicate !== undefined) {
        return `two players with email ${duplicate}`;
    }
    return null;
}

function checkTurnOrder({ after }) {
    const { room } = after;
    const duplicate = findDuplicate(after.players.map((player) => player.turn_order));
    if (duplicate !== undefined) {
        return `two players with turn_order ${duplicate}`;
    }

    const isCurrentPlayer = findPlayer(after, room.current_turn_player_id) !== null;
    if (room.status === 'playing' && !isCurrentPlayer) {
        return `playing room's current_turn_player_id ${room.current_turn_player_id} is not a player`;
    }
    if (room.status === 'waiting' && room.current_turn_player_id !== null) {
        return `waiting room has current_turn_player_id ${room.current_turn_player_id}`;
    }
    return null;
}

// --- Rounds and the finished game ----------------------------------------

function checkRoundProgress({ action, before, after }) {
    if (!before) {
        return null;
    }

    const from = before.room.current_round;
    const to = after.room.current_round;
    if (from === to || to === from + 1) {
        return null;
    }

    const isPlayAgainReset = action === 'play-again' && to === 1;
    if (isPlayAgainReset) {
        return null;
    }
    return `current_round went from ${from} to ${to} on ${action}`;
}

/** Why a finished room may have no winner: no players, or the winner just left. */
function isMissingWinnerAllowed(before, after) {
    if (after.players.length === 0) {
        return true;
    }
    if (!before || before.room.status !== 'finished') {
        return false;
    }

    const previousWinnerId = before.room.winner_player_id;
    if (previousWinnerId === null) {
        return true;
    }
    return findPlayer(after, previousWinnerId) === null;
}

/** A max_score win is added when the game finishes, and taken back when it is reopened. */
function expectedWins(previous, { before, after }) {
    const { room } = after;
    const isNewlyFinished = room.status === 'finished' && before.room.status !== 'finished';
    if (isNewlyFinished && room.finish_reason === 'max_score' && previous.id === room.winner_player_id) {
        return previous.games_won + 1;
    }

    const isReopened = before.room.status === 'finished' && room.status === 'playing';
    const hadWin = before.room.finish_reason === 'max_score' && previous.id === before.room.winner_player_id;
    if (isReopened && hadWin) {
        return Math.max(0, previous.games_won - 1);
    }
    return previous.games_won;
}

function describeWinsChange(before, after) {
    for (const player of after.players) {
        const previous = findPlayer(before, player.id);
        if (!previous) {
            continue;
        }

        const expected = expectedWins(previous, { before, after });
        if (player.games_won !== expected) {
            return `${player.name} has games_won ${player.games_won}, expected ${expected}`;
        }
    }
    return null;
}

function checkFinishedGame({ action, before, after }) {
    const { room } = after;
    const isNewlyFinished = room.status === 'finished' && before?.room.status !== 'finished';

    if (isNewlyFinished && !['max_score', 'ended'].includes(room.finish_reason)) {
        return `game finished with finish_reason ${room.finish_reason}`;
    }
    if (room.status === 'finished') {
        if (room.winner_player_id === null && !isMissingWinnerAllowed(before, after)) {
            return `finished game has no winner after ${action}`;
        }
        if (room.winner_player_id !== null && !findPlayer(after, room.winner_player_id)) {
            return `winner_player_id ${room.winner_player_id} is not a player`;
        }
    }

    if (!before) {
        return null;
    }
    return describeWinsChange(before, after);
}

// --- Version and event log -----------------------------------------------

function describeSeqGap(events, lastSeq) {
    for (const [index, event] of events.entries()) {
        const expected = lastSeq + 1 + index;
        if (event.seq !== expected) {
            return `event seq ${event.seq} follows ${expected - 1}`;
        }
    }
    return null;
}

function checkVersionAndLog({ status, before, after, events, lastSeq }) {
    const gap = describeSeqGap(events, lastSeq);
    if (gap) {
        return gap;
    }
    if (!before) {
        return null;
    }

    const from = before.room.version;
    const to = after.room.version;
    const isCommitted = status === 200 && events.length > 0;
    if (!isCommitted) {
        if (events.length > 0 || to !== from) {
            return `an action answering ${status} logged ${events.length} events and moved version ${from} to ${to}`;
        }
        return null;
    }

    if (to !== from + 1) {
        return `committed action moved version from ${from} to ${to}`;
    }
    const staleEvent = events.find((event) => event.roomVersion !== to);
    if (staleEvent) {
        return `event ${staleEvent.seq} has room_version ${staleEvent.roomVersion}, room is at ${to}`;
    }
    return null;
}

// --- Not an invariant from the plan, but a 500 would hide the others -----

function checkNoServerError({ status, action }) {
    if (status >= 500) {
        return `${action} answered ${status}`;
    }
    return null;
}

/** Every invariant. */
export const INVARIANTS = [
    {
        id: 'totals',
        title: 'every Player.total_score equals the sum of their RoundScores, less 15 per Flip 7 attack on them',
        check: checkTotals,
    },
    {
        id: 'one-score-per-round',
        title: 'there is at most one RoundScore per player per round',
        check: checkOneScorePerRound,
    },
    {
        id: 'single-host',
        title: 'an open room with players has exactly one host, and a closed room has none',
        check: checkSingleHost,
    },
    {
        id: 'unique-emails',
        title: 'there is at most one Player per email in a room',
        check: checkUniqueEmails,
    },
    {
        id: 'turn-order',
        title: 'turn_order values are unique and current_turn_player_id is a player while playing, null while waiting',
        check: checkTurnOrder,
    },
    {
        id: 'round-progress',
        title: 'current_round only moves forward one at a time, except the reset to 1 on play-again',
        check: checkRoundProgress,
    },
    {
        id: 'submitted-flags',
        title: 'while playing, has_submitted_round is true exactly when the player has a RoundScore for the round',
        check: checkSubmittedFlags,
    },
    {
        id: 'final-score-range',
        title: 'every stored final_score is an integer from -1000 to 1000',
        check: checkFinalScoreRange,
    },
    {
        id: 'finished-game',
        title: 'a finished game names a winner unless nobody is left or the winner left, and only max_score adds a win',
        check: checkFinishedGame,
    },
    {
        id: 'version-and-log',
        title: 'room_version rises by one with every committed action and event seqs are consecutive',
        check: checkVersionAndLog,
    },
    {
        id: 'no-server-error',
        title: 'no action answers with a server error',
        check: checkNoServerError,
    },
];
