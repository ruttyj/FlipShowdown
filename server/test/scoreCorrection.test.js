import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, devLogin, startTestServer } from './helpers.js';

// Undoing a bust and correcting a score (X45).

describe('score correction', () => {
    let server;
    let baseUrl;
    const cookies = {};

    before(async () => {
        server = await startTestServer({ env: { ADMIN_EMAILS: 'boss@example.com' } });
        baseUrl = server.baseUrl;
        for (const name of ['host', 'ann', 'ben', 'late', 'outsider', 'boss']) {
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

    /** A started room with host, ann and ben. Resolves to the start response's body. */
    async function playingRoom({ maxScore = 200, gameMode } = {}) {
        const created = await api(baseUrl, 'POST', '/api/rooms', {
            cookie: cookies.host,
            body: { max_score: maxScore, game_mode: gameMode },
        });
        const roomId = created.body.room.id;
        await action('ann', roomId, 'join', { name: 'ann' });
        await action('ben', roomId, 'join', { name: 'ben' });
        const started = await action('host', roomId, 'start');
        assert.equal(started.status, 200);
        return started.body;
    }

    function score(finalScore, fields = {}) {
        return {
            round_number: 1,
            cards: [{ value: String(finalScore), type: 'number' }],
            base_sum: finalScore,
            final_score: finalScore,
            ...fields,
        };
    }

    function bust(fields = {}) {
        return { round_number: 1, cards: [], base_sum: 0, final_score: 0, busted: true, ...fields };
    }

    function playerOf(snapshot, name) {
        return snapshot.players.find((player) => player.email === `${name}@example.com`);
    }

    async function roundScores(roomId) {
        const query = encodeURIComponent(JSON.stringify({ room_id: roomId }));
        const response = await api(baseUrl, 'GET', `/api/entities/RoundScore?q=${query}`, { cookie: cookies.host });
        return response.body;
    }

    async function readRoom(roomId) {
        const response = await api(baseUrl, 'GET', `/api/entities/GameRoom/${roomId}`, { cookie: cookies.host });
        return response.body;
    }

    async function submitOk(who, roomId, body) {
        const response = await action(who, roomId, 'submit-score', body);
        assert.equal(response.status, 200);
        return response.body;
    }

    /** A game ann has just won on max_score in round 1. Resolves to the finishing snapshot. */
    async function finishedByMaxScore() {
        const snapshot = await playingRoom({ maxScore: 50 });
        const roomId = snapshot.room.id;
        await submitOk('host', roomId, score(5));
        await submitOk('ben', roomId, score(5));
        const finished = await submitOk('ann', roomId, score(60));
        assert.equal(finished.room.status, 'finished');
        assert.equal(playerOf(finished, 'ann').games_won, 1);
        return finished;
    }

    // --- The score's flags -----------------------------------------------

    test('submit stores busted and duplicate_allowed', async () => {
        const snapshot = await playingRoom({ gameMode: 'vengeance' });

        const busted = await submitOk('ann', snapshot.room.id, bust());
        const allowed = await submitOk('ben', snapshot.room.id, score(10, {
            cards: [{ value: '5', type: 'number' }, { value: '5', type: 'number' }],
            duplicate_allowed: true,
        }));

        assert.equal(busted.round_score.busted, true);
        assert.equal(allowed.round_score.duplicate_allowed, true);
        assert.equal(allowed.round_score.busted, false);
    });

    test('a bust keeps its hand', async () => {
        const snapshot = await playingRoom();
        const cards = [{ value: '5', type: 'number' }, { value: '5', type: 'number' }];

        const stored = await submitOk('ann', snapshot.room.id, bust({ cards }));

        assert.deepEqual(stored.round_score.cards, cards);
    });

    test('a score sent without the flags reads as not busted, and clears them on a re-submit', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;
        await submitOk('ann', roomId, bust());

        const replaced = await submitOk('ann', roomId, score(7));

        assert.equal(replaced.round_score.busted, false);
        assert.equal(replaced.round_score.duplicate_allowed, false);
    });

    for (const field of ['busted', 'duplicate_allowed']) {
        test(`a ${field} that is not a boolean is a bad request`, async () => {
            const snapshot = await playingRoom();

            const response = await action('ann', snapshot.room.id, 'submit-score', score(7, { [field]: 'yes' }));

            assert.equal(response.status, 400);
            assert.equal(response.body.code, 'bad_request');
        });
    }

    test('edit-score stores the flags and takes them away again', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;
        const annId = playerOf(snapshot, 'ann').id;

        const busted = await action('host', roomId, 'edit-score', { player_id: annId, ...bust() });
        assert.equal(busted.body.round_score.busted, true);

        const fixed = await action('host', roomId, 'edit-score', { player_id: annId, ...score(9) });
        assert.equal(fixed.body.round_score.busted, false);
    });

    test('force-next-round zeros are not marked busted', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;

        await action('host', roomId, 'force-next-round', { round_number: 1 });

        const scores = await roundScores(roomId);
        assert.equal(scores.length, 3);
        for (const stored of scores) {
            assert.notEqual(stored.busted, true);
        }
    });

    // A retry is the same request again, so anything else under the same round must not pass as one.
    test('a retry after the round moved on counts as applied only if the flags match too', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;
        await submitOk('host', roomId, score(5));
        await submitOk('ben', roomId, score(5));
        await submitOk('ann', roomId, bust());

        const retry = await action('ann', roomId, 'submit-score', bust());
        assert.equal(retry.status, 200);
        assert.equal(retry.body.already_applied, true);

        const notBusted = await action('ann', roomId, 'submit-score', { ...bust(), busted: false });
        assert.equal(notBusted.status, 409);
        assert.equal(notBusted.body.code, 'round_mismatch');
        assert.equal(notBusted.body.stored_score.busted, true);
    });

    test('a retry differing only in duplicate_allowed is a mismatch', async () => {
        const snapshot = await playingRoom({ gameMode: 'vengeance' });
        const roomId = snapshot.room.id;
        const hand = score(10, {
            cards: [{ value: '5', type: 'number' }, { value: '5', type: 'number' }],
            duplicate_allowed: true,
        });
        await submitOk('host', roomId, score(5));
        await submitOk('ben', roomId, score(5));
        await submitOk('ann', roomId, hand);

        const differs = await action('ann', roomId, 'submit-score', { ...hand, duplicate_allowed: false });

        assert.equal(differs.status, 409);
        assert.equal(differs.body.code, 'round_mismatch');
    });

    test('a bust retried against an old force-next-round zero is a mismatch, not applied', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;
        await action('host', roomId, 'force-next-round', { round_number: 1 });

        const late = await action('ann', roomId, 'submit-score', bust());

        assert.equal(late.status, 409);
        assert.equal(late.body.code, 'round_mismatch');
    });

    // --- retract-score ---------------------------------------------------

    test('retract deletes my score, clears my round and answers with what it deleted', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;
        await submitOk('ann', roomId, score(12));

        const response = await action('ann', roomId, 'retract-score', { round_number: 1 });

        assert.equal(response.status, 200);
        assert.equal(response.body.already_applied, false);
        assert.equal(response.body.round_score.final_score, 12);
        const ann = playerOf(response.body, 'ann');
        assert.equal(ann.has_submitted_round, false);
        assert.equal(ann.current_round_score, 0);
        assert.equal(ann.total_score, 0);
        assert.deepEqual(await roundScores(roomId), []);
    });

    test('retract only takes this round out of my total', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;
        await submitOk('host', roomId, score(1));
        await submitOk('ben', roomId, score(1));
        await submitOk('ann', roomId, score(20));
        await submitOk('ann', roomId, score(7, { round_number: 2 }));

        const response = await action('ann', roomId, 'retract-score', { round_number: 2 });

        assert.equal(playerOf(response.body, 'ann').total_score, 20);
    });

    test('retract leaves the other players alone', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;
        await submitOk('ben', roomId, score(9));
        await submitOk('ann', roomId, score(12));

        const response = await action('ann', roomId, 'retract-score', { round_number: 1 });

        const ben = playerOf(response.body, 'ben');
        assert.equal(ben.has_submitted_round, true);
        assert.equal(ben.total_score, 9);
        assert.equal((await roundScores(roomId)).length, 1);
    });

    test('after a retract the round waits for me, and my new score counts', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;
        await submitOk('host', roomId, score(1));
        await submitOk('ann', roomId, score(12));
        await action('ann', roomId, 'retract-score', { round_number: 1 });

        const benIn = await submitOk('ben', roomId, score(3));
        assert.equal(benIn.room.current_round, 1);

        const annBack = await submitOk('ann', roomId, score(4));
        assert.equal(annBack.room.current_round, 2);
        assert.equal(playerOf(annBack, 'ann').total_score, 4);
    });

    test('once the round has moved on it is a round_mismatch, with what is stored', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;
        await submitOk('host', roomId, score(1));
        await submitOk('ben', roomId, score(1));
        await submitOk('ann', roomId, bust());

        const response = await action('ann', roomId, 'retract-score', { round_number: 1 });

        assert.equal(response.status, 409);
        assert.equal(response.body.code, 'round_mismatch');
        assert.equal(response.body.current_round, 2);
        assert.equal(response.body.stored_score.busted, true);
        assert.equal((await roundScores(roomId)).length, 3);
    });

    test('a retry after a lost response reports already applied and changes nothing', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;
        await submitOk('ann', roomId, score(12));
        await action('ann', roomId, 'retract-score', { round_number: 1 });
        const versionBefore = (await readRoom(roomId)).version;

        const retry = await action('ann', roomId, 'retract-score', { round_number: 1 });

        assert.equal(retry.status, 200);
        assert.equal(retry.body.already_applied, true);
        assert.equal(retry.body.round_score, null);
        assert.equal((await readRoom(roomId)).version, versionBefore);
    });

    test('retract is allowed during edit mode, and runs no round check', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;
        await action('host', roomId, 'set-edit-mode', { on: true });
        await submitOk('ann', roomId, score(12));

        const response = await action('ann', roomId, 'retract-score', { round_number: 1 });

        assert.equal(response.status, 200);
        assert.equal(response.body.room.is_edit_mode, true);
    });

    test('retract never completes a round', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;
        await submitOk('host', roomId, score(1));
        await submitOk('ben', roomId, score(1));

        const response = await action('ann', roomId, 'retract-score', { round_number: 1 });

        assert.equal(response.status, 200);
        assert.equal(response.body.room.current_round, 1);
        assert.equal(response.body.already_applied, true);
    });

    test('retract for a bad round number is a bad request', async () => {
        const snapshot = await playingRoom();

        const response = await action('ann', snapshot.room.id, 'retract-score', { round_number: 'one' });

        assert.equal(response.status, 400);
    });

    test('only a member can retract', async () => {
        const snapshot = await playingRoom();

        const response = await action('outsider', snapshot.room.id, 'retract-score', { round_number: 1 });

        assert.equal(response.status, 403);
        assert.equal(response.body.code, 'not_member');
    });

    test('a finished game answers wrong_status', async () => {
        const finished = await finishedByMaxScore();

        const response = await action('ann', finished.room.id, 'retract-score', { round_number: 1 });

        assert.equal(response.status, 409);
        assert.equal(response.body.code, 'wrong_status');
        assert.equal(response.body.status, 'finished');
    });

    // --- The race against the last submit --------------------------------

    test('the last submit first: the retract is refused and the round stands', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;
        await submitOk('host', roomId, score(1));
        await submitOk('ann', roomId, score(12));

        const last = await submitOk('ben', roomId, score(3));
        const retract = await action('ann', roomId, 'retract-score', { round_number: 1 });

        assert.equal(last.room.current_round, 2);
        assert.equal(retract.status, 409);
        assert.equal(retract.body.code, 'round_mismatch');
    });

    test('the retract first: the last submit no longer completes the round', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;
        await submitOk('host', roomId, score(1));
        await submitOk('ann', roomId, score(12));

        await action('ann', roomId, 'retract-score', { round_number: 1 });
        const last = await submitOk('ben', roomId, score(3));

        assert.equal(last.room.current_round, 1);
        assert.equal(playerOf(last, 'ann').has_submitted_round, false);
    });

    test('sent together, either order leaves a consistent room', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;
        await submitOk('host', roomId, score(1));
        await submitOk('ann', roomId, score(12));

        const [retract, last] = await Promise.all([
            action('ann', roomId, 'retract-score', { round_number: 1 }),
            action('ben', roomId, 'submit-score', score(3)),
        ]);

        assert.equal(last.status, 200);
        const room = await readRoom(roomId);
        const scores = await roundScores(roomId);
        if (retract.status === 200) {
            assert.equal(room.current_round, 1);
            assert.equal(scores.length, 2);
        } else {
            assert.equal(retract.body.code, 'round_mismatch');
            assert.equal(room.current_round, 2);
            assert.equal(scores.length, 3);
        }
    });

    // --- The mode lock follows the scores (X41) --------------------------

    test('once every round 1 score is retracted, the mode can change again', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;
        await submitOk('ann', roomId, score(12));
        await submitOk('ben', roomId, score(5));

        const locked = await action('host', roomId, 'set-game-mode', { game_mode: 'vengeance' });
        assert.equal(locked.body.code, 'mode_locked');

        await action('ann', roomId, 'retract-score', { round_number: 1 });
        const stillLocked = await action('host', roomId, 'set-game-mode', { game_mode: 'vengeance' });
        assert.equal(stillLocked.body.code, 'mode_locked');

        await action('ben', roomId, 'retract-score', { round_number: 1 });
        const unlocked = await action('host', roomId, 'set-game-mode', { game_mode: 'vengeance' });
        assert.equal(unlocked.status, 200);
        assert.equal(unlocked.body.room.game_mode, 'vengeance');
    });

    // --- reopen-game -----------------------------------------------------

    test('reopen brings the game back with edit mode on, owned by the host', async () => {
        const finished = await finishedByMaxScore();
        const roomId = finished.room.id;

        const response = await action('host', roomId, 'reopen-game');

        assert.equal(response.status, 200);
        const { room } = response.body;
        assert.equal(room.status, 'playing');
        assert.equal(room.winner_player_id, null);
        assert.equal(room.finish_reason, null);
        assert.equal(room.is_edit_mode, true);
        assert.equal(room.edit_mode_by, playerOf(response.body, 'host').id);
        assert.equal(room.current_round, finished.room.current_round);
        assert.equal((await roundScores(roomId)).length, 3);
    });

    test('reopen takes the win back', async () => {
        const finished = await finishedByMaxScore();

        const response = await action('host', finished.room.id, 'reopen-game');

        assert.equal(playerOf(response.body, 'ann').games_won, 0);
    });

    test('a win that was edited down to 0 stays at 0', async () => {
        const finished = await finishedByMaxScore();
        const roomId = finished.room.id;
        await action('host', roomId, 'set-games-won', { wins: { [playerOf(finished, 'ann').id]: 0 } });

        const response = await action('host', roomId, 'reopen-game');

        assert.equal(playerOf(response.body, 'ann').games_won, 0);
    });

    test('a winner who has left does not stop the reopen', async () => {
        const finished = await finishedByMaxScore();
        const roomId = finished.room.id;
        await action('ann', roomId, 'leave');

        const response = await action('host', roomId, 'reopen-game');

        assert.equal(response.status, 200);
        assert.equal(response.body.room.status, 'playing');
    });

    test('an ended game never added a win, so nothing comes off', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;
        await action('host', roomId, 'set-games-won', { wins: { [playerOf(snapshot, 'host').id]: 3 } });
        await action('host', roomId, 'end-game');

        const response = await action('host', roomId, 'reopen-game');

        assert.equal(response.body.room.status, 'playing');
        assert.equal(playerOf(response.body, 'host').games_won, 3);
    });

    test('a second reopen is wrong_status, so the win comes off once', async () => {
        const finished = await finishedByMaxScore();
        const roomId = finished.room.id;
        await action('host', roomId, 'set-games-won', { wins: { [playerOf(finished, 'ann').id]: 5 } });
        await action('host', roomId, 'reopen-game');

        const again = await action('host', roomId, 'reopen-game');

        assert.equal(again.status, 409);
        assert.equal(again.body.code, 'wrong_status');
        const state = await action('host', roomId, 'set-edit-mode', { on: true });
        assert.equal(playerOf(state.body, 'ann').games_won, 4);
    });

    test('only the host can reopen', async () => {
        const finished = await finishedByMaxScore();

        const response = await action('ann', finished.room.id, 'reopen-game');

        assert.equal(response.status, 403);
        assert.equal(response.body.code, 'not_host');
    });

    test('an admin outside the room reopens with no edit mode owner', async () => {
        const finished = await finishedByMaxScore();

        const response = await action('boss', finished.room.id, 'reopen-game');

        assert.equal(response.status, 200);
        assert.equal(response.body.room.is_edit_mode, true);
        assert.equal(response.body.room.edit_mode_by, null);
    });

    test('a game still playing is wrong_status', async () => {
        const snapshot = await playingRoom();

        const response = await action('host', snapshot.room.id, 'reopen-game');

        assert.equal(response.status, 409);
        assert.equal(response.body.code, 'wrong_status');
    });

    test('after Play Again it is wrong_status, as the old scores are gone', async () => {
        const finished = await finishedByMaxScore();
        const roomId = finished.room.id;
        await action('host', roomId, 'play-again');

        const response = await action('host', roomId, 'reopen-game');

        assert.equal(response.status, 409);
        assert.equal(response.body.code, 'wrong_status');
        assert.equal(response.body.status, 'waiting');
    });

    test('Done Editing with the winning score unchanged finishes again, counting one win', async () => {
        const finished = await finishedByMaxScore();
        const roomId = finished.room.id;
        await action('host', roomId, 'reopen-game');

        const done = await action('host', roomId, 'set-edit-mode', { on: false });

        assert.equal(done.body.room.status, 'finished');
        assert.equal(done.body.room.finish_reason, 'max_score');
        assert.equal(done.body.room.winner_player_id, playerOf(done.body, 'ann').id);
        assert.equal(playerOf(done.body, 'ann').games_won, 1);
    });

    test('Done Editing after fixing a misread crowns the right winner', async () => {
        const finished = await finishedByMaxScore();
        const roomId = finished.room.id;
        await action('host', roomId, 'reopen-game');
        const annId = playerOf(finished, 'ann').id;
        const benId = playerOf(finished, 'ben').id;
        await action('host', roomId, 'edit-score', { player_id: annId, ...score(6) });
        await action('host', roomId, 'edit-score', { player_id: benId, ...score(55) });

        const done = await action('host', roomId, 'set-edit-mode', { on: false });

        assert.equal(done.body.room.status, 'finished');
        assert.equal(done.body.room.winner_player_id, benId);
        assert.equal(playerOf(done.body, 'ann').games_won, 0);
        assert.equal(playerOf(done.body, 'ben').games_won, 1);
    });

    test('Done Editing with nobody over max_score carries on into the next round', async () => {
        const finished = await finishedByMaxScore();
        const roomId = finished.room.id;
        await action('host', roomId, 'reopen-game');
        await action('host', roomId, 'edit-score', { player_id: playerOf(finished, 'ann').id, ...score(6) });

        const done = await action('host', roomId, 'set-edit-mode', { on: false });

        assert.equal(done.body.room.status, 'playing');
        assert.equal(done.body.room.current_round, 2);
        assert.equal(done.body.room.is_edit_mode, false);
        assert.equal(playerOf(done.body, 'ann').games_won, 0);
    });

    test('a player who joined after the finish holds the round until they score', async () => {
        const finished = await finishedByMaxScore();
        const roomId = finished.room.id;
        await action('late', roomId, 'join', { name: 'late' });
        await action('host', roomId, 'reopen-game');

        const done = await action('host', roomId, 'set-edit-mode', { on: false });
        assert.equal(done.body.room.status, 'playing');
        assert.equal(done.body.room.current_round, 1);

        const scored = await submitOk('late', roomId, score(1));
        assert.equal(scored.room.status, 'finished');
        assert.equal(playerOf(scored, 'ann').games_won, 1);
    });

    // A forced zero is stored without marking the player submitted, because the round is over by
    // then. Reopened, they would look unscored and hold the round for a score they already have.
    test('a game finished by Force Next Round finishes again on Done Editing', async () => {
        const snapshot = await playingRoom({ maxScore: 50 });
        const roomId = snapshot.room.id;
        await submitOk('ann', roomId, score(60));
        const forced = await action('host', roomId, 'force-next-round', { round_number: 1 });
        assert.equal(forced.body.room.status, 'finished');

        const reopened = await action('host', roomId, 'reopen-game');
        assert.equal(playerOf(reopened.body, 'ben').has_submitted_round, true);

        const done = await action('host', roomId, 'set-edit-mode', { on: false });
        assert.equal(done.body.room.status, 'finished');
        assert.equal(playerOf(done.body, 'ann').games_won, 1);
    });

    test('an ended game with scores missing waits for them, or Force Next Round', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;
        await submitOk('ann', roomId, score(12));
        await action('host', roomId, 'end-game');
        await action('host', roomId, 'reopen-game');

        const done = await action('host', roomId, 'set-edit-mode', { on: false });
        assert.equal(done.body.room.status, 'playing');
        assert.equal(done.body.room.current_round, 1);
        assert.equal(playerOf(done.body, 'ben').has_submitted_round, false);

        const forced = await action('host', roomId, 'force-next-round', { round_number: 1 });
        assert.equal(forced.body.room.current_round, 2);
    });

    // --- The dealer after a reopen (X4) ------------------------------------

    function dealerName(snapshot) {
        const dealer = snapshot.players.find((player) => player.id === snapshot.room.current_turn_player_id);
        return dealer.name;
    }

    test('a dealer leaving the round that finished the game: the turn stays on the next player after a reopen', async () => {
        const snapshot = await playingRoom({ maxScore: 50 });
        const roomId = snapshot.room.id;
        await submitOk('ann', roomId, score(60));
        await submitOk('ben', roomId, score(1));
        const left = await action('host', roomId, 'leave');
        assert.equal(left.body.room.status, 'finished');
        // Ann takes the host role as the next by turn order, and the next round's deal with it.
        assert.equal(dealerName(left.body), 'ann');

        const reopened = await action('ann', roomId, 'reopen-game');
        assert.equal(reopened.status, 200);
        await action('ann', roomId, 'edit-score', { ...score(10), player_id: playerOf(reopened.body, 'ann').id });

        const done = await action('ann', roomId, 'set-edit-mode', { on: false });
        assert.equal(done.body.room.status, 'playing');
        assert.equal(done.body.room.current_round, 2);
        assert.equal(dealerName(done.body), 'ann');
    });

    test('a dealer leaving a finished game: the next player still deals after a reopen', async () => {
        const snapshot = await playingRoom({ maxScore: 50 });
        const roomId = snapshot.room.id;
        await submitOk('host', roomId, score(1));
        await submitOk('ann', roomId, score(60));
        const finished = await submitOk('ben', roomId, score(1));
        assert.equal(finished.room.status, 'finished');

        const left = await action('host', roomId, 'leave');
        assert.equal(dealerName(left.body), 'ann');

        const reopened = await action('ann', roomId, 'reopen-game');
        await action('ann', roomId, 'edit-score', { ...score(10), player_id: playerOf(reopened.body, 'ann').id });
        const done = await action('ann', roomId, 'set-edit-mode', { on: false });

        assert.equal(done.body.room.current_round, 2);
        assert.equal(dealerName(done.body), 'ann');
    });

    test('a dealer leaving a game finished by Force Next Round: the next player still deals after a reopen', async () => {
        const snapshot = await playingRoom({ maxScore: 50 });
        const roomId = snapshot.room.id;
        await submitOk('ann', roomId, score(60));
        const forced = await action('host', roomId, 'force-next-round', { round_number: 1 });
        assert.equal(forced.body.room.status, 'finished');

        const left = await action('host', roomId, 'leave');
        assert.equal(dealerName(left.body), 'ann');

        const reopened = await action('ann', roomId, 'reopen-game');
        await action('ann', roomId, 'edit-score', { ...score(10), player_id: playerOf(reopened.body, 'ann').id });
        const done = await action('ann', roomId, 'set-edit-mode', { on: false });

        assert.equal(done.body.room.current_round, 2);
        assert.equal(dealerName(done.body), 'ann');
    });

    test('a dealer leaving a game ended mid-round: the next player deals the rest of it, then the turn moves on', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;
        await action('host', roomId, 'end-game');
        const left = await action('host', roomId, 'leave');
        assert.equal(dealerName(left.body), 'ann');

        await action('ann', roomId, 'reopen-game');
        await submitOk('ann', roomId, score(5));
        await submitOk('ben', roomId, score(5));
        const done = await action('ann', roomId, 'set-edit-mode', { on: false });

        assert.equal(done.body.room.current_round, 2);
        assert.equal(dealerName(done.body), 'ben');
    });

    test('with no dealer leaving, a reopen rotates the deal as usual', async () => {
        const snapshot = await playingRoom({ maxScore: 50 });
        const roomId = snapshot.room.id;
        await submitOk('host', roomId, score(1));
        await submitOk('ann', roomId, score(60));
        await submitOk('ben', roomId, score(1));

        const reopened = await action('host', roomId, 'reopen-game');
        await action('host', roomId, 'edit-score', { ...score(10), player_id: playerOf(reopened.body, 'ann').id });
        const done = await action('host', roomId, 'set-edit-mode', { on: false });

        assert.equal(done.body.room.current_round, 2);
        assert.equal(dealerName(done.body), 'ann');
    });

    test('a passed turn does not carry over into the next game', async () => {
        const snapshot = await playingRoom({ maxScore: 50 });
        const roomId = snapshot.room.id;
        await submitOk('ann', roomId, score(60));
        await submitOk('ben', roomId, score(1));
        await action('host', roomId, 'leave');

        const again = await action('ann', roomId, 'play-again');

        assert.equal(again.body.room.turn_passed_round, null);
    });

    test('reopen keeps the mode', async () => {
        const snapshot = await playingRoom({ gameMode: 'vengeance' });
        const roomId = snapshot.room.id;
        await submitOk('ann', roomId, score(12));
        await action('host', roomId, 'end-game');

        const response = await action('host', roomId, 'reopen-game');

        assert.equal(response.body.room.game_mode, 'vengeance');
    });
});
