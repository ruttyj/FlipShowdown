import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { RoundService } from '../../src/services/RoundService.js';
import { HOST, openRoom } from './serviceFixture.js';

// The seeded room has GUEST at turn_order 0 and HOST at turn_order 1.

describe('RoundService', () => {
    const rounds = new RoundService();
    let room;

    afterEach(() => {
        room.close();
    });

    describe('finishGame', () => {
        test('a max_score finish names the highest total and counts their win', () => {
            room = openRoom({ is_edit_mode: true, edit_mode_by: 'someone' });
            room.updatePlayer(room.hostId, { total_score: 210, games_won: 2 });
            room.updatePlayer(room.guestId, { total_score: 150 });
            const work = room.workFor(HOST);

            rounds.finishGame(work, 'max_score');

            assert.equal(work.room.status, 'finished');
            assert.equal(work.room.finish_reason, 'max_score');
            assert.equal(work.room.winner_player_id, room.hostId);
            assert.equal(work.room.is_edit_mode, false);
            assert.equal(work.room.edit_mode_by, null);
            assert.equal(room.player(room.hostId).games_won, 3);
        });

        test('a winner with no games_won yet gets 1, and a tie goes to the lower turn_order', () => {
            room = openRoom();
            room.updatePlayer(room.hostId, { total_score: 200, games_won: null });
            room.updatePlayer(room.guestId, { total_score: 200, games_won: null });
            const work = room.workFor(HOST);

            rounds.finishGame(work, 'max_score');

            assert.equal(work.room.winner_player_id, room.guestId);
            assert.equal(room.player(room.guestId).games_won, 1);
        });

        test('an ended game names a winner without counting a win', () => {
            room = openRoom();
            room.updatePlayer(room.hostId, { total_score: 30 });
            const work = room.workFor(HOST);

            rounds.finishGame(work, 'ended');

            assert.equal(work.room.finish_reason, 'ended');
            assert.equal(work.room.winner_player_id, room.hostId);
            assert.equal(room.player(room.hostId).games_won, 0);
        });

        test('a room with no players finishes without a winner', () => {
            room = openRoom();
            room.store.repositories.players.delete(room.hostId);
            room.store.repositories.players.delete(room.guestId);
            const work = room.workFor(HOST);

            rounds.finishGame(work, 'max_score');

            assert.equal(work.room.status, 'finished');
            assert.equal(work.room.winner_player_id, null);
        });
    });

    describe('advanceRound', () => {
        test('moves to the next round, resets submissions and passes the deal on by turn order', () => {
            room = openRoom();
            room.updatePlayer(room.hostId, { has_submitted_round: true, current_round_score: 9 });
            room.updatePlayer(room.guestId, { has_submitted_round: true, current_round_score: 4 });
            room.updateRoom({ current_turn_player_id: room.guestId });
            const work = room.workFor(HOST);

            rounds.advanceRound(work);

            assert.equal(work.room.current_round, 2);
            assert.equal(work.room.current_turn_player_id, room.hostId);
            assert.equal(work.room.turn_passed_round, null);
            for (const playerId of [room.hostId, room.guestId]) {
                assert.equal(room.player(playerId).has_submitted_round, false);
                assert.equal(room.player(playerId).current_round_score, 0);
            }
        });

        test('the deal wraps around from the last player to the first', () => {
            room = openRoom();
            room.updateRoom({ current_turn_player_id: room.hostId });
            const work = room.workFor(HOST);

            rounds.advanceRound(work);

            assert.equal(work.room.current_turn_player_id, room.guestId);
        });

        test('a turn already passed this round stays with its holder', () => {
            room = openRoom({ turn_passed_round: 1 });
            room.updateRoom({ current_turn_player_id: room.hostId });
            const work = room.workFor(HOST);

            rounds.advanceRound(work);

            assert.equal(work.room.current_turn_player_id, room.hostId);
            assert.equal(work.room.turn_passed_round, null);
        });

        test('an unset or departed dealer falls back to the first player by turn order', () => {
            room = openRoom({ current_turn_player_id: 'gone-player' });
            const work = room.workFor(HOST);

            rounds.advanceRound(work);

            assert.equal(work.room.current_turn_player_id, room.guestId);
        });

        test('a lone player keeps the deal', () => {
            room = openRoom();
            room.store.repositories.players.delete(room.guestId);
            room.updateRoom({ current_turn_player_id: room.hostId });
            const work = room.workFor(HOST);

            rounds.advanceRound(work);

            assert.equal(work.room.current_turn_player_id, room.hostId);
        });

        test('finishes the game instead when someone has reached max_score', () => {
            room = openRoom({ max_score: 100 });
            room.updatePlayer(room.guestId, { total_score: 100 });
            const work = room.workFor(HOST);

            rounds.advanceRound(work);

            assert.equal(work.room.status, 'finished');
            assert.equal(work.room.current_round, 1);
            assert.equal(work.room.winner_player_id, room.guestId);
        });
    });

    describe('runRoundCheck', () => {
        function everyoneSubmitted() {
            room.updatePlayer(room.hostId, { has_submitted_round: true });
            room.updatePlayer(room.guestId, { has_submitted_round: true });
        }

        test('advances once every player has submitted', () => {
            room = openRoom();
            everyoneSubmitted();
            const work = room.workFor(HOST);

            rounds.runRoundCheck(work);

            assert.equal(work.room.current_round, 2);
        });

        test('waits while a player has not submitted', () => {
            room = openRoom();
            room.updatePlayer(room.hostId, { has_submitted_round: true });
            const work = room.workFor(HOST);

            rounds.runRoundCheck(work);

            assert.equal(work.room.current_round, 1);
            assert.deepEqual(work.events, []);
        });

        test('does nothing while edit mode is on', () => {
            room = openRoom({ is_edit_mode: true });
            everyoneSubmitted();
            const work = room.workFor(HOST);

            rounds.runRoundCheck(work);

            assert.equal(work.room.current_round, 1);
        });

        test('does nothing when the room is not playing', () => {
            room = openRoom({ status: 'finished' });
            everyoneSubmitted();
            const work = room.workFor(HOST);

            rounds.runRoundCheck(work);

            assert.equal(work.room.current_round, 1);
        });

        test('does nothing in a room with no players', () => {
            room = openRoom();
            room.store.repositories.players.delete(room.hostId);
            room.store.repositories.players.delete(room.guestId);
            const work = room.workFor(HOST);

            rounds.runRoundCheck(work);

            assert.equal(work.room.current_round, 1);
        });
    });
});
