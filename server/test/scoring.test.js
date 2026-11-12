import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, devLogin, startTestServer } from './helpers.js';

describe('scoring and round actions', () => {
    let server;
    let baseUrl;
    const cookies = {};

    before(async () => {
        server = await startTestServer({ env: { ADMIN_EMAILS: 'boss@example.com' } });
        baseUrl = server.baseUrl;
        for (const name of ['host', 'ann', 'ben', 'outsider', 'boss']) {
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

    /** A room with host, then the joiners in order, already started. */
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

    function score(finalScore, round = 1) {
        return {
            round_number: round,
            cards: [{ value: String(finalScore), type: 'number' }],
            base_sum: finalScore,
            final_score: finalScore,
        };
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

    /** Every name in `names` submits `points` for `round`. Returns the last response. */
    async function submitAll(roomId, names, points, round = 1) {
        let last;
        for (const name of names) {
            last = await action(name, roomId, 'submit-score', score(points, round));
            assert.equal(last.status, 200);
        }
        return last;
    }

    // --- Submit and advance ----------------------------------------------

    test('submit stores one RoundScore, sets the total and waits for others', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;

        const response = await action('ann', roomId, 'submit-score', score(12));
        assert.equal(response.status, 200);
        assert.equal(response.body.already_applied, false);
        assert.equal(response.body.round_score.final_score, 12);

        const ann = playerOf(response.body, 'ann');
        assert.equal(ann.total_score, 12);
        assert.equal(ann.current_round_score, 12);
        assert.equal(ann.has_submitted_round, true);
        assert.equal(response.body.room.current_round, 1);
    });

    test('submitting twice keeps one RoundScore and does not double the total', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;

        await action('ann', roomId, 'submit-score', score(12));
        const again = await action('ann', roomId, 'submit-score', score(12));
        assert.equal(again.status, 200);
        assert.equal(playerOf(again.body, 'ann').total_score, 12);

        const replaced = await action('ann', roomId, 'submit-score', score(20));
        assert.equal(playerOf(replaced.body, 'ann').total_score, 20);

        const scores = await roundScores(roomId);
        assert.equal(scores.length, 1);
        assert.equal(scores[0].final_score, 20);
    });

    test('concurrent submits that complete a round advance once and rotate the turn', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;
        assert.equal(snapshot.room.current_turn_player_id, playerOf(snapshot, 'host').id);

        const responses = await Promise.all(
            ['host', 'ann', 'ben'].map((name) => action(name, roomId, 'submit-score', score(5))),
        );
        for (const response of responses) {
            assert.equal(response.status, 200);
        }

        const room = await readRoom(roomId);
        assert.equal(room.current_round, 2);
        assert.equal(room.current_turn_player_id, playerOf(snapshot, 'ann').id);

        const last = await action('host', roomId, 'submit-score', score(1, 2));
        for (const player of last.body.players) {
            assert.equal(player.total_score, player.email === 'host@example.com' ? 6 : 5);
        }
        const others = last.body.players.filter((player) => player.email !== 'host@example.com');
        for (const player of others) {
            assert.equal(player.has_submitted_round, false);
            assert.equal(player.current_round_score, 0);
        }
    });

    test('the turn wraps around to the first player', async () => {
        const snapshot = await playingRoom(['ann']);
        const roomId = snapshot.room.id;

        await submitAll(roomId, ['host', 'ann'], 1, 1);
        const second = await submitAll(roomId, ['host', 'ann'], 1, 2);
        assert.equal(second.body.room.current_round, 3);
        assert.equal(second.body.room.current_turn_player_id, playerOf(snapshot, 'host').id);
    });

    test('a stale round_number is already_applied when it matches, else round_mismatch', async () => {
        const snapshot = await playingRoom(['ann']);
        const roomId = snapshot.room.id;
        await submitAll(roomId, ['host', 'ann'], 7);

        const retry = await action('ann', roomId, 'submit-score', score(7, 1));
        assert.equal(retry.status, 200);
        assert.equal(retry.body.already_applied, true);
        assert.equal(retry.body.room.current_round, 2);
        assert.equal(playerOf(retry.body, 'ann').total_score, 7);

        const different = await action('ann', roomId, 'submit-score', score(9, 1));
        assert.equal(different.status, 409);
        assert.equal(different.body.code, 'round_mismatch');
        assert.equal(different.body.current_round, 2);
        assert.equal(different.body.stored_score.final_score, 7);

        const differentBaseSum = await action('ann', roomId, 'submit-score', { ...score(7, 1), base_sum: 5 });
        assert.equal(differentBaseSum.status, 409);
        assert.equal(differentBaseSum.body.code, 'round_mismatch');

        const future = await action('ann', roomId, 'submit-score', score(9, 5));
        assert.equal(future.status, 409);
        assert.equal(future.body.stored_score, null);
    });

    test('submit validates the score fields', async () => {
        const snapshot = await playingRoom(['ann']);
        const roomId = snapshot.room.id;

        const badBodies = [
            { ...score(5), final_score: 1001 },
            { ...score(5), base_sum: -1001 },
            { ...score(5), final_score: 2.5 },
            { ...score(5), cards: 'none' },
            { ...score(5), cards: [{ value: 5, type: 'number' }] },
            { ...score(5), cards: Array.from({ length: 31 }, () => ({ value: '1', type: 'number' })) },
            { ...score(5), round_number: 0 },
        ];
        for (const body of badBodies) {
            const response = await action('ann', roomId, 'submit-score', body);
            assert.equal(response.status, 400, JSON.stringify(body));
            assert.equal(response.body.code, 'bad_request');
        }
    });

    // --- Finish ----------------------------------------------------------

    test('reaching max_score finishes once, picks the winner and adds one win', async () => {
        const snapshot = await playingRoom(['ann'], 50);
        const roomId = snapshot.room.id;

        await action('host', roomId, 'submit-score', score(30));
        const finished = await action('ann', roomId, 'submit-score', score(60));
        assert.equal(finished.status, 200);
        assert.equal(finished.body.room.status, 'finished');
        assert.equal(finished.body.room.finish_reason, 'max_score');
        assert.equal(finished.body.room.winner_player_id, playerOf(snapshot, 'ann').id);
        assert.equal(playerOf(finished.body, 'ann').games_won, 1);
        assert.equal(playerOf(finished.body, 'host').games_won, 0);

        const retry = await action('ann', roomId, 'submit-score', score(60));
        assert.equal(retry.status, 409);
        assert.equal(retry.body.code, 'wrong_status');
        const ended = await action('host', roomId, 'end-game');
        assert.equal(ended.status, 409);

        const room = await readRoom(roomId);
        assert.equal(room.winner_player_id, playerOf(snapshot, 'ann').id);
    });

    test('a tie goes to the lower turn_order', async () => {
        const snapshot = await playingRoom(['ann', 'ben'], 50);
        const roomId = snapshot.room.id;

        await action('host', roomId, 'submit-score', score(10));
        await action('ben', roomId, 'submit-score', score(55));
        const finished = await action('ann', roomId, 'submit-score', score(55));
        assert.equal(finished.body.room.winner_player_id, playerOf(snapshot, 'ann').id);
        assert.equal(playerOf(finished.body, 'ann').games_won, 1);
        assert.equal(playerOf(finished.body, 'ben').games_won, 0);
    });

    test('end-game finishes with reason ended and no win', async () => {
        const snapshot = await playingRoom(['ann']);
        const roomId = snapshot.room.id;
        await action('ann', roomId, 'submit-score', score(40));
        await action('host', roomId, 'set-edit-mode', { on: true });

        const ended = await action('host', roomId, 'end-game');
        assert.equal(ended.status, 200);
        assert.equal(ended.body.room.status, 'finished');
        assert.equal(ended.body.room.finish_reason, 'ended');
        assert.equal(ended.body.room.is_edit_mode, false);
        assert.equal(ended.body.room.winner_player_id, playerOf(snapshot, 'ann').id);
        for (const player of ended.body.players) {
            assert.equal(player.games_won, 0);
        }
    });

    // --- Force next round ------------------------------------------------

    test('force-next-round zero-scores the unsubmitted and advances', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;
        await action('ann', roomId, 'submit-score', score(8));

        const forced = await action('host', roomId, 'force-next-round', { round_number: 1 });
        assert.equal(forced.status, 200);
        assert.equal(forced.body.room.current_round, 2);
        assert.equal(forced.body.room.current_turn_player_id, playerOf(snapshot, 'ann').id);
        assert.equal(playerOf(forced.body, 'ann').total_score, 8);

        const scores = await roundScores(roomId);
        assert.equal(scores.length, 3);
        const zeroScores = scores.filter((roundScore) => roundScore.final_score === 0);
        assert.equal(zeroScores.length, 2);
        for (const zero of zeroScores) {
            assert.deepEqual(zero.cards, []);
        }
    });

    test('the host on two devices forcing together advances once', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;
        const secondDevice = await devLogin(baseUrl, 'host@example.com', 'host');

        const responses = await Promise.all([
            action('host', roomId, 'force-next-round', { round_number: 1 }),
            api(baseUrl, 'POST', `/api/rooms/${roomId}/actions/force-next-round`, {
                cookie: secondDevice,
                body: { round_number: 1 },
            }),
        ]);
        const statuses = responses.map((response) => response.status).sort();
        assert.deepEqual(statuses, [200, 409]);
        const rejected = responses.find((response) => response.status === 409);
        assert.equal(rejected.body.code, 'round_mismatch');
        assert.equal(rejected.body.current_round, 2);

        const room = await readRoom(roomId);
        assert.equal(room.current_round, 2);
        assert.equal((await roundScores(roomId)).length, 3);
    });

    test('force-next-round ends edit mode and can finish the game', async () => {
        const snapshot = await playingRoom(['ann'], 50);
        const roomId = snapshot.room.id;
        await action('host', roomId, 'set-edit-mode', { on: true });
        await action('ann', roomId, 'submit-score', score(70));

        const forced = await action('host', roomId, 'force-next-round', { round_number: 1 });
        assert.equal(forced.body.room.is_edit_mode, false);
        assert.equal(forced.body.room.edit_mode_by, null);
        assert.equal(forced.body.room.status, 'finished');
        assert.equal(forced.body.room.finish_reason, 'max_score');
        assert.equal(playerOf(forced.body, 'ann').games_won, 1);
    });

    // --- Edit mode and edit-score ----------------------------------------

    test('edit mode blocks the auto-advance and turning it off advances', async () => {
        const snapshot = await playingRoom(['ann']);
        const roomId = snapshot.room.id;

        const on = await action('host', roomId, 'set-edit-mode', { on: true });
        assert.equal(on.body.room.is_edit_mode, true);
        assert.equal(on.body.room.edit_mode_by, playerOf(snapshot, 'host').id);

        const waiting = await submitAll(roomId, ['host', 'ann'], 4);
        assert.equal(waiting.body.room.current_round, 1);

        const off = await action('host', roomId, 'set-edit-mode', { on: false });
        assert.equal(off.body.room.is_edit_mode, false);
        assert.equal(off.body.room.edit_mode_by, null);
        assert.equal(off.body.room.current_round, 2);
    });

    test('edit-score recomputes totals and marks the current round submitted', async () => {
        const snapshot = await playingRoom(['ann']);
        const roomId = snapshot.room.id;
        const annId = playerOf(snapshot, 'ann').id;
        await submitAll(roomId, ['host', 'ann'], 10);
        await action('host', roomId, 'set-edit-mode', { on: true });

        const pastEdit = await action('host', roomId, 'edit-score', { ...score(3, 1), player_id: annId });
        assert.equal(pastEdit.status, 200);
        assert.equal(playerOf(pastEdit.body, 'ann').total_score, 3);
        assert.equal(playerOf(pastEdit.body, 'ann').has_submitted_round, false);

        const currentEdit = await action('host', roomId, 'edit-score', { ...score(6, 2), player_id: annId });
        assert.equal(playerOf(currentEdit.body, 'ann').total_score, 9);
        assert.equal(playerOf(currentEdit.body, 'ann').has_submitted_round, true);
        assert.equal(playerOf(currentEdit.body, 'ann').current_round_score, 6);

        const repeat = await action('host', roomId, 'edit-score', { ...score(6, 2), player_id: annId });
        assert.equal(playerOf(repeat.body, 'ann').total_score, 9);
        assert.equal((await roundScores(roomId)).length, 3);

        const future = await action('host', roomId, 'edit-score', { ...score(6, 3), player_id: annId });
        assert.equal(future.status, 400);
        const unknown = await action('host', roomId, 'edit-score', { ...score(6, 2), player_id: 'nobody' });
        assert.equal(unknown.status, 404);
        assert.equal(unknown.body.code, 'player_not_found');
    });

    test('edit-score completing the round with edit mode off advances', async () => {
        const snapshot = await playingRoom(['ann']);
        const roomId = snapshot.room.id;
        await action('host', roomId, 'submit-score', score(2));

        const edited = await action('host', roomId, 'edit-score', {
            ...score(5, 1),
            player_id: playerOf(snapshot, 'ann').id,
        });
        assert.equal(edited.body.room.current_round, 2);
    });

    // --- Leave and kick --------------------------------------------------

    test('a leave that completes the round advances it', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;
        await submitAll(roomId, ['host', 'ann'], 3);

        const left = await action('ben', roomId, 'leave');
        assert.equal(left.status, 200);
        assert.equal(left.body.room.current_round, 2);
    });

    test('a kick that completes the round advances it', async () => {
        const snapshot = await playingRoom();
        const roomId = snapshot.room.id;
        await submitAll(roomId, ['host', 'ben'], 3);

        const kicked = await action('host', roomId, 'kick', { player_id: playerOf(snapshot, 'ann').id });
        assert.equal(kicked.status, 200);
        assert.equal(kicked.body.room.current_round, 2);
        assert.equal(kicked.body.players.length, 2);
    });

    // --- After the game --------------------------------------------------

    test('play-again resets the game and keeps every player', async () => {
        const snapshot = await playingRoom(['ann', 'ben'], 20);
        const roomId = snapshot.room.id;
        await submitAll(roomId, ['host', 'ann', 'ben'], 25);

        const again = await action('host', roomId, 'play-again');
        assert.equal(again.status, 200);
        const room = again.body.room;
        assert.equal(room.status, 'waiting');
        assert.equal(room.current_round, 1);
        assert.equal(room.current_turn_player_id, null);
        assert.equal(room.is_edit_mode, false);
        assert.equal(room.winner_player_id, null);
        assert.equal(room.finish_reason, null);

        assert.equal(again.body.players.length, 3);
        for (const player of again.body.players) {
            assert.equal(player.total_score, 0);
            assert.equal(player.current_round_score, 0);
            assert.equal(player.has_submitted_round, false);
        }
        assert.equal(playerOf(again.body, 'host').games_won, 1);
        assert.deepEqual(await roundScores(roomId), []);

        const repeat = await action('host', roomId, 'play-again');
        assert.equal(repeat.status, 409);
        assert.equal(repeat.body.code, 'wrong_status');
    });

    test('set-games-won sets wins and validates the map', async () => {
        const snapshot = await playingRoom(['ann']);
        const roomId = snapshot.room.id;
        const annId = playerOf(snapshot, 'ann').id;
        const hostId = playerOf(snapshot, 'host').id;

        const set = await action('host', roomId, 'set-games-won', { wins: { [annId]: 3, [hostId]: 1 } });
        assert.equal(set.status, 200);
        assert.equal(playerOf(set.body, 'ann').games_won, 3);
        assert.equal(playerOf(set.body, 'host').games_won, 1);

        const negative = await action('host', roomId, 'set-games-won', { wins: { [annId]: -1 } });
        assert.equal(negative.status, 400);

        const unknown = await action('host', roomId, 'set-games-won', { wins: { [annId]: 9, nobody: 1 } });
        assert.equal(unknown.status, 404);
        const unchanged = await action('host', roomId, 'set-games-won', { wins: {} });
        assert.equal(playerOf(unchanged.body, 'ann').games_won, 3);
    });

    // --- Permissions and status ------------------------------------------

    test('host-only actions reject members and outsiders', async () => {
        const snapshot = await playingRoom(['ann']);
        const roomId = snapshot.room.id;
        const annId = playerOf(snapshot, 'ann').id;
        const hostOnly = [
            ['force-next-round', { round_number: 1 }],
            ['set-edit-mode', { on: true }],
            ['edit-score', { ...score(1), player_id: annId }],
            ['end-game', {}],
            ['play-again', {}],
            ['set-games-won', { wins: {} }],
        ];

        for (const [name, body] of hostOnly) {
            const member = await action('ann', roomId, name, body);
            assert.equal(member.status, 403, name);
            assert.equal(member.body.code, 'not_host', name);

            const outsider = await action('outsider', roomId, name, body);
            assert.equal(outsider.status, 403, name);
            assert.equal(outsider.body.code, 'not_member', name);
        }
    });

    test('member actions reject outsiders and admins without a player', async () => {
        const snapshot = await playingRoom(['ann']);
        const roomId = snapshot.room.id;

        for (const who of ['outsider', 'boss']) {
            const submit = await action(who, roomId, 'submit-score', score(1));
            assert.equal(submit.status, 403);
            assert.equal(submit.body.code, 'not_member');
        }

        const adminForce = await action('boss', roomId, 'force-next-round', { round_number: 1 });
        assert.equal(adminForce.status, 200);
        const adminEnd = await action('boss', roomId, 'end-game');
        assert.equal(adminEnd.status, 200);

    });

    test('each action rejects the wrong room status', async () => {
        const created = await api(baseUrl, 'POST', '/api/rooms', { cookie: cookies.host, body: { max_score: 50 } });
        const roomId = created.body.room.id;
        const hostId = created.body.player.id;
        const playingOnly = [
            ['submit-score', score(1)],
            ['force-next-round', { round_number: 1 }],
            ['set-edit-mode', { on: true }],
            ['edit-score', { ...score(1), player_id: hostId }],
            ['end-game', {}],
        ];
        const finishedOnly = [['play-again', {}]];

        for (const [name, body] of [...playingOnly, ...finishedOnly]) {
            const response = await action('host', roomId, name, body);
            assert.equal(response.status, 409, name);
            assert.equal(response.body.code, 'wrong_status', name);
            assert.equal(response.body.status, 'waiting', name);
        }

        await action('host', roomId, 'start');
        for (const [name, body] of finishedOnly) {
            const response = await action('host', roomId, name, body);
            assert.equal(response.body.status, 'playing', name);
        }

        await action('host', roomId, 'end-game');
        for (const [name, body] of playingOnly) {
            const response = await action('host', roomId, name, body);
            assert.equal(response.body.status, 'finished', name);
        }

        await action('host', roomId, 'close');
        const gamesWon = await action('host', roomId, 'set-games-won', { wins: { [hostId]: 1 } });
        assert.equal(gamesWon.status, 409);
        assert.equal(gamesWon.body.status, 'closed');
    });
});
