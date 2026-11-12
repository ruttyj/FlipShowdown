import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, devLogin, startTestServer } from './helpers.js';

// Round edges (test plan B5): winners and ties, the dealer after a leave or
// kick (X4), finish reasons, mid-game joiners, late edits and negative
// scores (X1).

describe('round edges', () => {
    let server;
    let baseUrl;
    const cookies = {};

    before(async () => {
        server = await startTestServer();
        baseUrl = server.baseUrl;
        for (const name of ['host', 'ann', 'ben', 'cat']) {
            cookies[name] = await devLogin(baseUrl, `${name}@example.com`, name);
        }
    });

    after(async () => {
        await server.stop();
    });

    // --- Helpers ---------------------------------------------------------

    function action(who, roomId, name, body = {}) {
        return api(baseUrl, 'POST', `/api/rooms/${roomId}/actions/${name}`, { cookie: cookies[who], body });
    }

    /** A started room with the host first, then the joiners in turn order. Returns the snapshot. */
    async function playingRoom(joiners = ['ann', 'ben'], maxScore = 200) {
        const created = await api(baseUrl, 'POST', '/api/rooms', {
            cookie: cookies.host,
            body: { max_score: maxScore },
        });
        const roomId = created.body.room.id;
        for (const name of joiners) {
            await action(name, roomId, 'join', { name });
        }

        const started = await action('host', roomId, 'start');
        assert.equal(started.status, 200);
        return started.body;
    }

    function score(finalScore, round = 1, baseSum = finalScore) {
        return {
            round_number: round,
            cards: [{ value: String(baseSum), type: 'number' }],
            base_sum: baseSum,
            final_score: finalScore,
        };
    }

    function playerOf(snapshot, name) {
        return snapshot.players.find((player) => player.email === `${name}@example.com`);
    }

    /** Each name submits `points` for `round`, all expected to succeed. Returns the last response. */
    async function submitAll(roomId, names, points, round = 1) {
        let last;
        for (const name of names) {
            last = await action(name, roomId, 'submit-score', score(points, round));
            assert.equal(last.status, 200, JSON.stringify(last.body));
        }
        return last;
    }

    /** Plays round 1 with everyone scoring 0, so round 2 is dealt by the second player (ann). */
    async function roomInRoundTwo(joiners = ['ann', 'ben']) {
        const snapshot = await playingRoom(joiners);
        const roomId = snapshot.room.id;
        const advanced = await submitAll(roomId, ['host', ...joiners], 0);
        assert.equal(advanced.body.room.current_round, 2);
        assert.equal(advanced.body.room.current_turn_player_id, playerOf(snapshot, 'ann').id);
        return snapshot;
    }

    // --- Winner -----------------------------------------------------------

    test('a three-way tie at max_score goes to the lowest turn_order', async () => {
        const snapshot = await playingRoom(['ann', 'ben'], 50);
        const roomId = snapshot.room.id;

        const finished = await submitAll(roomId, ['ben', 'ann', 'host'], 50);
        assert.equal(finished.body.room.status, 'finished');
        assert.equal(finished.body.room.winner_player_id, playerOf(snapshot, 'host').id);
        assert.equal(playerOf(finished.body, 'host').games_won, 1);
        assert.equal(playerOf(finished.body, 'ann').games_won, 0);
        assert.equal(playerOf(finished.body, 'ben').games_won, 0);
    });

    test('when several players cross max_score in one round the highest total wins', async () => {
        const snapshot = await playingRoom(['ann', 'ben'], 50);
        const roomId = snapshot.room.id;

        await action('host', roomId, 'submit-score', score(60));
        await action('ann', roomId, 'submit-score', score(75));
        const finished = await action('ben', roomId, 'submit-score', score(55));
        assert.equal(finished.body.room.status, 'finished');
        assert.equal(finished.body.room.finish_reason, 'max_score');
        assert.equal(finished.body.room.winner_player_id, playerOf(snapshot, 'ann').id);
        assert.equal(playerOf(finished.body, 'ann').games_won, 1);
    });

    // --- Dealer after a leave or kick (X4) --------------------------------

    test('the dealer leaving to complete the round makes the next player in turn order deal', async () => {
        const snapshot = await roomInRoundTwo();
        const roomId = snapshot.room.id;
        await submitAll(roomId, ['host', 'ben'], 3, 2);

        const left = await action('ann', roomId, 'leave');
        assert.equal(left.status, 200);
        assert.equal(left.body.room.current_round, 3);
        assert.equal(left.body.room.current_turn_player_id, playerOf(snapshot, 'ben').id);
    });

    test('the dealer being kicked to complete the round makes the next player in turn order deal', async () => {
        const snapshot = await roomInRoundTwo();
        const roomId = snapshot.room.id;
        await submitAll(roomId, ['host', 'ben'], 3, 2);

        const kicked = await action('host', roomId, 'kick', { player_id: playerOf(snapshot, 'ann').id });
        assert.equal(kicked.status, 200);
        assert.equal(kicked.body.room.current_round, 3);
        assert.equal(kicked.body.room.current_turn_player_id, playerOf(snapshot, 'ben').id);
    });

    test('the last dealer in turn order leaving to complete the round wraps to the first player', async () => {
        const snapshot = await playingRoom(['ann', 'ben']);
        const roomId = snapshot.room.id;
        await submitAll(roomId, ['host', 'ann', 'ben'], 0);
        await submitAll(roomId, ['host', 'ann', 'ben'], 0, 2);
        await submitAll(roomId, ['host', 'ann'], 0, 3);

        const left = await action('ben', roomId, 'leave');
        assert.equal(left.body.room.current_round, 4);
        assert.equal(left.body.room.current_turn_player_id, playerOf(snapshot, 'host').id);
    });

    test('a non-dealer leaving to complete the round rotates the dealer as usual', async () => {
        const snapshot = await roomInRoundTwo();
        const roomId = snapshot.room.id;
        await submitAll(roomId, ['host', 'ann'], 3, 2);

        const left = await action('ben', roomId, 'leave');
        assert.equal(left.body.room.current_round, 3);
        assert.equal(left.body.room.current_turn_player_id, playerOf(snapshot, 'host').id);
    });

    test('the dealer leaving mid-round hands the deal on and the round then rotates from there', async () => {
        const snapshot = await roomInRoundTwo(['ann', 'ben', 'cat']);
        const roomId = snapshot.room.id;

        const left = await action('ann', roomId, 'leave');
        assert.equal(left.body.room.current_round, 2);
        assert.equal(left.body.room.current_turn_player_id, playerOf(snapshot, 'ben').id);

        const advanced = await submitAll(roomId, ['host', 'ben', 'cat'], 3, 2);
        assert.equal(advanced.body.room.current_round, 3);
        assert.equal(advanced.body.room.current_turn_player_id, playerOf(snapshot, 'cat').id);
    });

    // X4b: edit mode holds the round check at the leave, so the round advances later.
    test('the dealer leaving during edit mode after everyone else submitted still makes the next player deal', async () => {
        const snapshot = await roomInRoundTwo();
        const roomId = snapshot.room.id;
        await submitAll(roomId, ['host', 'ben'], 3, 2);
        await action('host', roomId, 'set-edit-mode', { on: true });

        const left = await action('ann', roomId, 'leave');
        assert.equal(left.status, 200);
        assert.equal(left.body.room.current_round, 2);
        // X20: the turn goes straight to the next dealer, with no stand-in.
        assert.equal(left.body.room.current_turn_player_id, playerOf(snapshot, 'ben').id);

        const advanced = await action('host', roomId, 'set-edit-mode', { on: false });
        assert.equal(advanced.status, 200);
        assert.equal(advanced.body.room.current_round, 3);
        assert.equal(advanced.body.room.current_turn_player_id, playerOf(snapshot, 'ben').id);
    });

    // X20: the next dealer here is the first player, so a joiner who lands
    // after the last player must not be rotated onto in their place.
    test('the dealer leaving during edit mode, then a mid-game join, still makes the next player deal', async () => {
        const snapshot = await playingRoom(['ann', 'ben']);
        const roomId = snapshot.room.id;
        await submitAll(roomId, ['host', 'ann', 'ben'], 0);
        await submitAll(roomId, ['host', 'ann', 'ben'], 0, 2);
        await submitAll(roomId, ['host', 'ann'], 0, 3);
        await action('host', roomId, 'set-edit-mode', { on: true });
        const hostId = playerOf(snapshot, 'host').id;

        const left = await action('ben', roomId, 'leave');
        assert.equal(left.body.room.current_round, 3);
        assert.equal(left.body.room.current_turn_player_id, hostId);

        await action('cat', roomId, 'join', { name: 'cat' });
        const editOff = await action('host', roomId, 'set-edit-mode', { on: false });
        assert.equal(editOff.body.room.current_round, 3);
        assert.equal(editOff.body.room.current_turn_player_id, hostId);

        const advanced = await action('cat', roomId, 'submit-score', score(0, 3));
        assert.equal(advanced.body.room.current_round, 4);
        assert.equal(advanced.body.room.current_turn_player_id, hostId);

        // The round after that rotates normally again.
        const rotated = await submitAll(roomId, ['host', 'ann', 'cat'], 0, 4);
        assert.equal(rotated.body.room.current_round, 5);
        assert.equal(rotated.body.room.current_turn_player_id, playerOf(snapshot, 'ann').id);
    });

    test('the next dealer leaving too while edit mode holds the round hands the deal on again', async () => {
        const snapshot = await roomInRoundTwo(['ann', 'ben', 'cat']);
        const roomId = snapshot.room.id;
        await submitAll(roomId, ['host', 'ben', 'cat'], 0, 2);
        await action('host', roomId, 'set-edit-mode', { on: true });

        await action('ann', roomId, 'leave');
        const benLeft = await action('ben', roomId, 'leave');
        assert.equal(benLeft.body.room.current_turn_player_id, playerOf(snapshot, 'cat').id);

        const advanced = await action('host', roomId, 'set-edit-mode', { on: false });
        assert.equal(advanced.body.room.current_round, 3);
        assert.equal(advanced.body.room.current_turn_player_id, playerOf(snapshot, 'cat').id);
    });

    test('ending the game while edit mode holds a passed turn does not carry it into the rematch', async () => {
        const snapshot = await roomInRoundTwo();
        const roomId = snapshot.room.id;
        await submitAll(roomId, ['host', 'ben'], 0, 2);
        await action('host', roomId, 'set-edit-mode', { on: true });
        await action('ann', roomId, 'leave');
        await action('host', roomId, 'end-game');
        await action('host', roomId, 'play-again');
        await action('host', roomId, 'start');

        const advanced = await submitAll(roomId, ['host', 'ben'], 0, 1);
        assert.equal(advanced.body.room.current_round, 2);
        assert.equal(advanced.body.room.current_turn_player_id, playerOf(snapshot, 'ben').id);
    });

    // --- Finish reasons ----------------------------------------------------

    test('end-game names the leader as winner but adds no win', async () => {
        const snapshot = await playingRoom(['ann']);
        const roomId = snapshot.room.id;
        await action('ann', roomId, 'submit-score', score(40));

        const ended = await action('host', roomId, 'end-game');
        assert.equal(ended.body.room.finish_reason, 'ended');
        assert.equal(ended.body.room.winner_player_id, playerOf(snapshot, 'ann').id);
        assert.equal(playerOf(ended.body, 'ann').games_won, 0);
    });

    test('reaching max_score names the winner and adds one win', async () => {
        const snapshot = await playingRoom(['ann'], 50);
        const roomId = snapshot.room.id;

        await action('host', roomId, 'submit-score', score(10));
        const finished = await action('ann', roomId, 'submit-score', score(50));
        assert.equal(finished.body.room.finish_reason, 'max_score');
        assert.equal(finished.body.room.winner_player_id, playerOf(snapshot, 'ann').id);
        assert.equal(playerOf(finished.body, 'ann').games_won, 1);
    });

    // --- Playing alone (X63) -----------------------------------------------

    test('a host alone can start, each score moves to the next round, and max_score ends it', async () => {
        const snapshot = await playingRoom([], 50);
        const roomId = snapshot.room.id;
        assert.equal(snapshot.room.status, 'playing');

        const advanced = await action('host', roomId, 'submit-score', score(20));
        assert.equal(advanced.body.room.current_round, 2);

        const finished = await action('host', roomId, 'submit-score', score(30, 2));
        assert.equal(finished.body.room.status, 'finished');
        assert.equal(finished.body.room.winner_player_id, playerOf(snapshot, 'host').id);
    });

    // --- Joining mid-game --------------------------------------------------

    test('a player joining mid-game starts at 0 and the round waits for them', async () => {
        const snapshot = await playingRoom(['ann']);
        const roomId = snapshot.room.id;
        await action('host', roomId, 'submit-score', score(10));

        const joined = await action('ben', roomId, 'join', { name: 'ben' });
        assert.equal(joined.status, 200);
        const ben = joined.body.player;
        assert.equal(ben.total_score, 0);
        assert.equal(ben.current_round_score, 0);
        assert.equal(ben.has_submitted_round, false);
        assert.equal(ben.turn_order, 2);

        const annSubmitted = await action('ann', roomId, 'submit-score', score(10));
        assert.equal(annSubmitted.body.room.current_round, 1);

        const benSubmitted = await action('ben', roomId, 'submit-score', score(10));
        assert.equal(benSubmitted.body.room.current_round, 2);
    });

    test('a player joining during edit mode, after everyone else submitted, holds the round', async () => {
        const snapshot = await playingRoom(['ann']);
        const roomId = snapshot.room.id;
        await action('host', roomId, 'set-edit-mode', { on: true });
        await submitAll(roomId, ['host', 'ann'], 10);

        const joined = await action('ben', roomId, 'join', { name: 'ben' });
        assert.equal(joined.status, 200);
        assert.equal(joined.body.player.total_score, 0);

        const editOff = await action('host', roomId, 'set-edit-mode', { on: false });
        assert.equal(editOff.body.room.current_round, 1);

        const benSubmitted = await action('ben', roomId, 'submit-score', score(10));
        assert.equal(benSubmitted.body.room.current_round, 2);
    });

    // --- Editing an old round ----------------------------------------------

    test('editing an old round past max_score finishes the game only when the current round ends', async () => {
        const snapshot = await playingRoom(['ann'], 50);
        const roomId = snapshot.room.id;
        await submitAll(roomId, ['host', 'ann'], 10);
        const annId = playerOf(snapshot, 'ann').id;

        const edited = await action('host', roomId, 'edit-score', { player_id: annId, ...score(60, 1) });
        assert.equal(edited.status, 200);
        assert.equal(edited.body.room.status, 'playing');
        assert.equal(playerOf(edited.body, 'ann').total_score, 60);

        await action('host', roomId, 'submit-score', score(0, 2));
        const finished = await action('ann', roomId, 'submit-score', score(0, 2));
        assert.equal(finished.body.room.status, 'finished');
        assert.equal(finished.body.room.finish_reason, 'max_score');
        assert.equal(finished.body.room.winner_player_id, annId);
    });

    // --- Negative scores (X1) -----------------------------------------------

    test('a negative final_score and base_sum are stored and lower the total', async () => {
        const snapshot = await playingRoom(['ann']);
        const roomId = snapshot.room.id;

        const submitted = await action('ann', roomId, 'submit-score', score(-7, 1, -3));
        assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
        assert.equal(submitted.body.round_score.final_score, -7);
        assert.equal(submitted.body.round_score.base_sum, -3);
        assert.equal(playerOf(submitted.body, 'ann').total_score, -7);
        assert.equal(playerOf(submitted.body, 'ann').current_round_score, -7);

        await action('host', roomId, 'submit-score', score(5));
        const edited = await action('host', roomId, 'edit-score', {
            player_id: playerOf(snapshot, 'ann').id,
            ...score(-1000, 1, -1000),
        });
        assert.equal(edited.status, 200, JSON.stringify(edited.body));
        assert.equal(playerOf(edited.body, 'ann').total_score, -1000);
    });

    test('scores from -1000 to 1000 are accepted', async () => {
        const snapshot = await playingRoom(['ann']);
        const roomId = snapshot.room.id;

        for (const value of [-1000, -1, 0, 1000]) {
            const response = await action('ann', roomId, 'submit-score', score(value, 1, value));
            assert.equal(response.status, 200, String(value));
        }
    });

    test('scores outside -1000 to 1000 or not integers are rejected', async () => {
        const snapshot = await playingRoom(['ann']);
        const roomId = snapshot.room.id;

        const badBodies = [
            { ...score(5), final_score: -1001 },
            { ...score(5), base_sum: -1001 },
            { ...score(5), final_score: 1001 },
            { ...score(5), base_sum: 1001 },
            { ...score(5), final_score: -2.5 },
            { ...score(5), base_sum: '-3' },
            { ...score(5), final_score: null },
        ];
        for (const body of badBodies) {
            const response = await action('ann', roomId, 'submit-score', body);
            assert.equal(response.status, 400, JSON.stringify(body));
            assert.equal(response.body.code, 'bad_request');

            const edited = await action('host', roomId, 'edit-score', {
                player_id: playerOf(snapshot, 'ann').id,
                ...body,
            });
            assert.equal(edited.status, 400, JSON.stringify(body));
        }
    });
});
