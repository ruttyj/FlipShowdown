import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { RoomService } from '../../src/services/RoomService.js';
import { RoundService } from '../../src/services/RoundService.js';
import { ScoringService, requireEditableRound } from '../../src/services/ScoringService.js';
import { TotalsService } from '../../src/services/TotalsService.js';
import {
    FLIP7_CARDS,
    GUEST,
    HOST,
    OUTSIDER,
    assertActionError,
    openRoom,
    scoreOf,
} from './serviceFixture.js';

// ScoringService with the real RoundService and TotalsService, on a room whose players are HOST
// and GUEST (GUEST first in turn order). The round check and totals themselves are covered in their
// own tests; here they are only followed far enough to see that they ran.

const FLIP7_SCORE = { cards: FLIP7_CARDS, base_sum: 28, final_score: 28 };

function createScoringService() {
    // ScoringService only uses RoomService#resetPlayersForNewGame, which reads no repository.
    const roomService = new RoomService({ roomRepository: null, playerRepository: null });
    return new ScoringService({ roundService: new RoundService(), totalsService: new TotalsService(), roomService });
}

describe('ScoringService', () => {
    const scoring = createScoringService();
    let room;

    afterEach(() => {
        room.close();
    });

    // --- submitScore -------------------------------------------------------

    describe('submitScore', () => {
        test('stores the caller\'s score, updates their total and marks them submitted', () => {
            room = openRoom();
            const work = room.workFor(GUEST);

            const result = scoring.submitScore(work, { roundNumber: 1, score: scoreOf(12), gameMode: undefined });

            assert.equal(result.already_applied, false);
            assert.equal(result.round_score.player_id, room.guestId);
            assert.equal(result.round_score.final_score, 12);
            const guest = room.player(room.guestId);
            assert.equal(guest.total_score, 12);
            assert.equal(guest.has_submitted_round, true);
            assert.equal(guest.current_round_score, 12);
            assert.equal(work.room.current_round, 1, 'the host has not submitted yet');
        });

        test('a second submit replaces the score rather than adding another', () => {
            room = openRoom();
            scoring.submitScore(room.workFor(GUEST), { roundNumber: 1, score: scoreOf(12) });

            scoring.submitScore(room.workFor(GUEST), { roundNumber: 1, score: scoreOf(3) });

            assert.equal(room.scores().length, 1);
            assert.equal(room.player(room.guestId).total_score, 3);
        });

        test('the last score of the round runs the round check, which advances', () => {
            room = openRoom();
            room.updatePlayer(room.hostId, { has_submitted_round: true });
            const work = room.workFor(GUEST);

            scoring.submitScore(work, { roundNumber: 1, score: scoreOf(5), gameMode: 'classic' });

            assert.equal(work.room.current_round, 2);
        });

        test('a score made under another mode is mode_changed, naming the room\'s mode', () => {
            room = openRoom({ game_mode: 'brutal' });

            const error = assertActionError(
                () => scoring.submitScore(room.workFor(GUEST), { roundNumber: 1, score: scoreOf(5), gameMode: 'classic' }),
                409,
                'mode_changed',
            );

            assert.equal(error.toBody().game_mode, 'brutal');
            assert.deepEqual(room.scores(), []);
        });

        test('a retry of a closed round\'s stored score is reported as applied', () => {
            room = openRoom({ current_round: 2 });
            const stored = room.addScore(room.guestId, 1, scoreOf(7));

            const result = scoring.submitScore(room.workFor(GUEST), { roundNumber: 1, score: scoreOf(7) });

            assert.deepEqual(result, { already_applied: true, round_score: stored });
        });

        test('a stored score without the newer fields matches a retry that has them at their defaults', () => {
            room = openRoom({ current_round: 2 });
            const legacy = scoreOf(7);
            delete legacy.busted;
            delete legacy.duplicate_allowed;
            delete legacy.flip7_attack_player_id;
            room.addScore(room.guestId, 1, legacy);

            const result = scoring.submitScore(room.workFor(GUEST), { roundNumber: 1, score: scoreOf(7) });

            assert.equal(result.already_applied, true);
        });

        test('any other submit for another round is round_mismatch with the stored score', () => {
            room = openRoom({ current_round: 2 });
            const stored = room.addScore(room.guestId, 1, scoreOf(7));
            const different = [
                scoreOf(8, { base_sum: 7 }),
                scoreOf(7, { base_sum: 6 }),
                scoreOf(7, { busted: true }),
                scoreOf(7, { duplicate_allowed: true }),
                scoreOf(7, { flip7_attack_player_id: room.hostId }),
                scoreOf(7, { cards: [] }),
            ];

            for (const score of different) {
                const error = assertActionError(
                    () => scoring.submitScore(room.workFor(GUEST), { roundNumber: 1, score }),
                    409,
                    'round_mismatch',
                );
                const body = error.toBody();
                assert.equal(body.current_round, 2);
                assert.deepEqual(body.stored_score, stored);
            }
        });

        test('a submit for a round with nothing stored is round_mismatch with a null stored score', () => {
            room = openRoom({ current_round: 2 });

            const error = assertActionError(
                () => scoring.submitScore(room.workFor(GUEST), { roundNumber: 3, score: scoreOf(7) }),
                409,
                'round_mismatch',
            );

            assert.equal(error.toBody().stored_score, null);
        });
    });

    // --- Flip 7 attacks ----------------------------------------------------

    describe('Flip 7 attacks', () => {
        function attackOn(targetId, fields = {}) {
            return { ...scoreOf(28), ...FLIP7_SCORE, flip7_attack_player_id: targetId, ...fields };
        }

        test('an attack takes 15 from the target, and replacing it moves the 15 to the new target', () => {
            room = openRoom({ game_mode: 'brutal' });
            const third = room.addPlayer({ email: 'third@example.com', name: 'Third', turn_order: 2 });

            scoring.submitScore(room.workFor(GUEST), { roundNumber: 1, score: attackOn(room.hostId) });
            assert.equal(room.player(room.hostId).total_score, -15);

            scoring.submitScore(room.workFor(GUEST), { roundNumber: 1, score: attackOn(third.id) });
            assert.equal(room.player(room.hostId).total_score, 0);
            assert.equal(room.player(third.id).total_score, -15);
            assert.equal(room.player(room.guestId).total_score, 28);
        });

        test('only a Brutal game has attacks', () => {
            room = openRoom();

            assertActionError(
                () => scoring.submitScore(room.workFor(GUEST), { roundNumber: 1, score: attackOn(room.hostId) }),
                400,
                'bad_request',
            );
        });

        test('only an unbusted Flip 7 hand can attack', () => {
            room = openRoom({ game_mode: 'brutal' });
            const notAFlip7 = attackOn(room.hostId, { cards: FLIP7_CARDS.slice(0, 6) });
            const busted = attackOn(room.hostId, { busted: true });

            for (const score of [notAFlip7, busted]) {
                assertActionError(
                    () => scoring.submitScore(room.workFor(GUEST), { roundNumber: 1, score }),
                    400,
                    'bad_request',
                );
            }
        });

        test('a duplicate vouched for as a Steal or Swap still makes a Flip 7', () => {
            room = openRoom({ game_mode: 'brutal' });
            const cards = [...FLIP7_CARDS.slice(0, 6), { value: '6', type: 'number' }, { value: '7', type: 'number' }];

            scoring.submitScore(room.workFor(GUEST), {
                roundNumber: 1,
                score: attackOn(room.hostId, { cards, duplicate_allowed: true }),
            });

            assert.equal(room.player(room.hostId).total_score, -15);
        });

        test('the target must be another player in the room', () => {
            room = openRoom({ game_mode: 'brutal' });

            for (const targetId of [room.guestId, 'gone-player']) {
                assertActionError(
                    () => scoring.submitScore(room.workFor(GUEST), { roundNumber: 1, score: attackOn(targetId) }),
                    400,
                    'bad_request',
                );
            }
        });

        test('a retry of a closed round\'s attack is applied without checking the target again', () => {
            room = openRoom({ game_mode: 'brutal', current_round: 2 });
            const score = attackOn('gone-player');
            room.addScore(room.guestId, 1, score);

            const result = scoring.submitScore(room.workFor(GUEST), { roundNumber: 1, score });

            assert.equal(result.already_applied, true);
        });
    });

    // --- retractScore ------------------------------------------------------

    describe('retractScore', () => {
        test('deletes the caller\'s score and undoes its total, submission and attack', () => {
            room = openRoom({ game_mode: 'brutal' });
            scoring.submitScore(room.workFor(GUEST), {
                roundNumber: 1,
                score: { ...scoreOf(28), ...FLIP7_SCORE, flip7_attack_player_id: room.hostId },
            });

            const result = scoring.retractScore(room.workFor(GUEST), 1);

            assert.equal(result.already_applied, false);
            assert.equal(result.round_score.final_score, 28);
            assert.deepEqual(room.scores(), []);
            const guest = room.player(room.guestId);
            assert.equal(guest.total_score, 0);
            assert.equal(guest.has_submitted_round, false);
            assert.equal(guest.current_round_score, 0);
            assert.equal(room.player(room.hostId).total_score, 0);
        });

        test('with nothing stored it changes nothing and says so', () => {
            room = openRoom();
            const work = room.workFor(GUEST);

            const result = scoring.retractScore(work, 1);

            assert.deepEqual(result, { already_applied: true, round_score: null });
            assert.deepEqual(work.events, []);
        });

        test('another round is round_mismatch with the stored score', () => {
            room = openRoom({ current_round: 2 });
            const stored = room.addScore(room.guestId, 1, scoreOf(4));

            const error = assertActionError(() => scoring.retractScore(room.workFor(GUEST), 1), 409, 'round_mismatch');

            assert.deepEqual(error.toBody().stored_score, stored);
            assert.equal(room.scores().length, 1);
        });
    });

    // --- editScore ---------------------------------------------------------

    describe('editScore', () => {
        test('corrects a past round\'s score without marking the player submitted', () => {
            room = openRoom({ current_round: 2 });
            room.addScore(room.guestId, 1, scoreOf(4));
            const guest = room.player(room.guestId);

            const result = scoring.editScore(room.workFor(HOST), { player: guest, roundNumber: 1, score: scoreOf(9) });

            assert.equal(result.round_score.final_score, 9);
            assert.equal(room.player(room.guestId).total_score, 9);
            assert.equal(room.player(room.guestId).has_submitted_round, false);
        });

        test('a current round edit marks the player submitted and runs the round check', () => {
            room = openRoom();
            room.updatePlayer(room.hostId, { has_submitted_round: true });
            const work = room.workFor(HOST);

            scoring.editScore(work, { player: room.player(room.guestId), roundNumber: 1, score: scoreOf(9) });

            assert.equal(work.room.current_round, 2);
        });

        test('checks the mode and the attack like a submit', () => {
            room = openRoom();
            const guest = room.player(room.guestId);

            assertActionError(
                () => scoring.editScore(room.workFor(HOST), { player: guest, roundNumber: 1, score: scoreOf(9), gameMode: 'brutal' }),
                409,
                'mode_changed',
            );
            assertActionError(
                () => scoring.editScore(room.workFor(HOST), {
                    player: guest,
                    roundNumber: 1,
                    score: scoreOf(9, { flip7_attack_player_id: room.hostId }),
                }),
                400,
                'bad_request',
            );
        });

        test('requireEditableRound allows rounds up to the current one', () => {
            const playingRoom = { current_round: 3 };

            requireEditableRound(playingRoom, 1);
            requireEditableRound(playingRoom, 3);
            assertActionError(() => requireEditableRound(playingRoom, 4), 400, 'bad_request');
        });
    });

    // --- Host round controls -----------------------------------------------

    describe('forceNextRound', () => {
        test('gives a 0 to whoever has no score, keeps existing scores, ends edit mode and advances', () => {
            room = openRoom({ is_edit_mode: true, edit_mode_by: 'someone' });
            // Edited in but not marked submitted, as edit-score does for a closed round's score.
            room.addScore(room.hostId, 1, scoreOf(6));
            const work = room.workFor(HOST);

            scoring.forceNextRound(work, 1);

            const scores = room.scores();
            assert.equal(scores.length, 2);
            assert.equal(scores.find((score) => score.player_id === room.hostId).final_score, 6);
            const zero = scores.find((score) => score.player_id === room.guestId);
            assert.deepEqual(zero.cards, []);
            assert.equal(zero.final_score, 0);
            assert.equal(work.room.is_edit_mode, false);
            assert.equal(work.room.current_round, 2);
        });

        test('a submitted player gets no 0', () => {
            room = openRoom();
            room.updatePlayer(room.guestId, { has_submitted_round: true });

            scoring.forceNextRound(room.workFor(HOST), 1);

            assert.deepEqual(room.scores().map((score) => score.player_id), [room.hostId]);
        });

        test('a round that is already over is round_mismatch without stored_score', () => {
            room = openRoom({ current_round: 2 });

            const error = assertActionError(() => scoring.forceNextRound(room.workFor(HOST), 1), 409, 'round_mismatch');

            assert.equal(error.toBody().current_round, 2);
            assert.equal('stored_score' in error.toBody(), false);
        });
    });

    describe('setEditMode', () => {
        test('on names the caller\'s Player as the owner', () => {
            room = openRoom();
            const work = room.workFor(HOST);

            scoring.setEditMode(work, true);

            assert.equal(work.room.is_edit_mode, true);
            assert.equal(work.room.edit_mode_by, room.hostId);
        });

        test('on by an admin without a Player names no owner', () => {
            room = openRoom();
            const work = room.workFor(OUTSIDER, { isAdmin: true });

            scoring.setEditMode(work, true);

            assert.equal(work.room.is_edit_mode, true);
            assert.equal(work.room.edit_mode_by, null);
        });

        test('off clears it and runs the round check', () => {
            room = openRoom({ is_edit_mode: true, edit_mode_by: 'someone' });
            room.updatePlayer(room.hostId, { has_submitted_round: true });
            room.updatePlayer(room.guestId, { has_submitted_round: true });
            const work = room.workFor(HOST);

            scoring.setEditMode(work, false);

            assert.equal(work.room.is_edit_mode, false);
            assert.equal(work.room.edit_mode_by, null);
            assert.equal(work.room.current_round, 2);
        });
    });

    test('endGame finishes with finish_reason ended and no win', () => {
        room = openRoom();
        room.updatePlayer(room.guestId, { total_score: 40 });
        const work = room.workFor(HOST);

        scoring.endGame(work);

        assert.equal(work.room.status, 'finished');
        assert.equal(work.room.finish_reason, 'ended');
        assert.equal(work.room.winner_player_id, room.guestId);
        assert.equal(room.player(room.guestId).games_won, 0);
    });

    // --- After the game ----------------------------------------------------

    describe('reopenGame', () => {
        function finishedRoom(finishReason, winnerFields = {}) {
            room = openRoom({ status: 'finished', finish_reason: finishReason });
            room.updateRoom({ winner_player_id: room.guestId });
            room.updatePlayer(room.guestId, { games_won: 1, ...winnerFields });
        }

        test('takes back a max_score win and goes back to playing in edit mode', () => {
            finishedRoom('max_score');
            const work = room.workFor(HOST);

            scoring.reopenGame(work);

            assert.equal(room.player(room.guestId).games_won, 0);
            assert.equal(work.room.status, 'playing');
            assert.equal(work.room.winner_player_id, null);
            assert.equal(work.room.finish_reason, null);
            assert.equal(work.room.is_edit_mode, true);
            assert.equal(work.room.edit_mode_by, room.hostId);
        });

        test('a win taken back never goes below 0', () => {
            finishedRoom('max_score', { games_won: 0 });

            scoring.reopenGame(room.workFor(HOST));

            assert.equal(room.player(room.guestId).games_won, 0);
        });

        test('a winner without games_won stays at 0', () => {
            finishedRoom('max_score', { games_won: null });

            scoring.reopenGame(room.workFor(HOST));

            assert.equal(room.player(room.guestId).games_won, 0);
        });

        test('an ended game has no win to take back', () => {
            finishedRoom('ended');

            scoring.reopenGame(room.workFor(HOST));

            assert.equal(room.player(room.guestId).games_won, 1);
        });

        test('a winner who has left has no win to take back', () => {
            finishedRoom('max_score');
            room.updateRoom({ winner_player_id: 'gone-player' });

            scoring.reopenGame(room.workFor(HOST));

            assert.equal(room.player(room.guestId).games_won, 1);
        });

        test('players with a score for the round count as submitted again', () => {
            finishedRoom('max_score');
            room.addScore(room.hostId, 1, scoreOf(0));

            scoring.reopenGame(room.workFor(HOST));

            assert.equal(room.player(room.hostId).has_submitted_round, true);
            assert.equal(room.player(room.guestId).has_submitted_round, false);
        });
    });

    describe('playAgain', () => {
        test('clears scores and resets the room and players for the next game', () => {
            room = openRoom({
                status: 'finished',
                game_number: 4,
                current_round: 6,
                turn_passed_round: 6,
                finish_reason: 'max_score',
            });
            room.updateRoom({ current_turn_player_id: room.hostId, winner_player_id: room.hostId });
            room.addScore(room.hostId, 6, scoreOf(50));
            room.updatePlayer(room.hostId, { total_score: 210, games_won: 2, has_submitted_round: true });
            const work = room.workFor(HOST);

            scoring.playAgain(work);

            assert.deepEqual(room.scores(), []);
            const host = room.player(room.hostId);
            assert.equal(host.total_score, 0);
            assert.equal(host.has_submitted_round, false);
            assert.equal(host.games_won, 2, 'wins carry over between games');
            assert.equal(work.room.status, 'waiting');
            assert.equal(work.room.game_number, 5);
            assert.equal(work.room.current_round, 1);
            assert.equal(work.room.current_turn_player_id, null);
            assert.equal(work.room.turn_passed_round, null);
            assert.equal(work.room.winner_player_id, null);
            assert.equal(work.room.finish_reason, null);
            assert.equal(work.room.is_edit_mode, false);
        });

        test('a room from before game_number was stored counts as game 1', () => {
            room = openRoom({ status: 'finished', game_number: null });
            const work = room.workFor(HOST);

            scoring.playAgain(work);

            assert.equal(work.room.game_number, 2);
        });
    });

    describe('setGamesWon', () => {
        test('sets games_won for each listed player', () => {
            room = openRoom();

            scoring.setGamesWon(room.workFor(HOST), { [room.hostId]: 3, [room.guestId]: 0 });

            assert.equal(room.player(room.hostId).games_won, 3);
            assert.equal(room.player(room.guestId).games_won, 0);
        });

        test('an unknown player is player_not_found', () => {
            room = openRoom();

            assertActionError(() => scoring.setGamesWon(room.workFor(HOST), { 'gone-player': 1 }), 404, 'player_not_found');
        });
    });
});
