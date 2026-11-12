import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, devLogin, startTestServer } from './helpers.js';

// Brutal's Flip 7 choice (X43): a score can take 15 from a rival
// instead of adding 15, and everything that changes that score has to move the rival's total too.

const SEVEN_NUMBERS = [1, 2, 3, 4, 5, 6, 7];
const SEVEN_SUM = 28;

describe('Brutal', () => {
    let server;
    let baseUrl;
    const cookies = {};

    before(async () => {
        server = await startTestServer();
        baseUrl = server.baseUrl;
        for (const name of ['host', 'ann', 'ben', 'cal']) {
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

    /** A started room with host, ann and ben. Resolves to { roomId, ids: { host, ann, ben } }. */
    async function playingRoom({ maxScore = 200, gameMode = 'brutal' } = {}) {
        const created = await api(baseUrl, 'POST', '/api/rooms', {
            cookie: cookies.host,
            body: { max_score: maxScore, game_mode: gameMode },
        });
        assert.equal(created.status, 200);
        const roomId = created.body.room.id;
        await action('ann', roomId, 'join', { name: 'ann' });
        await action('ben', roomId, 'join', { name: 'ben' });
        const started = await action('host', roomId, 'start');
        assert.equal(started.status, 200);

        const ids = {};
        for (const player of started.body.players) {
            ids[player.name] = player.id;
        }
        return { roomId, ids };
    }

    function numberCards(values) {
        return values.map((value) => ({ value: String(value), type: 'number' }));
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

    /** A Flip 7 hand: its bonus went on the attack, so it scores only its cards. */
    function attack(targetId, fields = {}) {
        return {
            round_number: 1,
            cards: numberCards(SEVEN_NUMBERS),
            base_sum: SEVEN_SUM,
            final_score: SEVEN_SUM,
            flip7_attack_player_id: targetId,
            ...fields,
        };
    }

    function roomQuery(roomId) {
        return encodeURIComponent(JSON.stringify({ room_id: roomId }));
    }

    async function readTotals(roomId) {
        const players = await api(baseUrl, 'GET', `/api/entities/Player?q=${roomQuery(roomId)}`, { cookie: cookies.host });
        const totals = {};
        for (const player of players.body) {
            totals[player.name] = player.total_score;
        }
        return totals;
    }

    async function readRoom(roomId) {
        const response = await api(baseUrl, 'GET', `/api/entities/GameRoom/${roomId}`, { cookie: cookies.host });
        return response.body;
    }

    async function readScores(roomId) {
        const scores = await api(baseUrl, 'GET', `/api/entities/RoundScore?q=${roomQuery(roomId)}`, { cookie: cookies.host });
        return scores.body;
    }

    /** Everyone scores so round 1 closes: ann's Flip 7 attacks ben. */
    async function closeRoundWithAttack(roomId, ids) {
        await action('host', roomId, 'submit-score', score(1));
        await action('ben', roomId, 'submit-score', score(2));
        const submitted = await action('ann', roomId, 'submit-score', attack(ids.ben));
        assert.equal(submitted.status, 200);
    }

    // --- The mode --------------------------------------------------------

    test('a room can be created in Brutal, and switched to it', async () => {
        const { roomId } = await playingRoom();
        assert.equal((await readRoom(roomId)).game_mode, 'brutal');

        const created = await api(baseUrl, 'POST', '/api/rooms', { cookie: cookies.host, body: { max_score: 200 } });
        const switched = await action('host', created.body.room.id, 'set-game-mode', { game_mode: 'brutal' });

        assert.equal(switched.status, 200);
        assert.equal(switched.body.room.game_mode, 'brutal');
    });

    test('a score worked out under Vengeance is refused in a Brutal room', async () => {
        const { roomId } = await playingRoom();

        const submitted = await action('ann', roomId, 'submit-score', score(5, { game_mode: 'vengeance' }));

        assert.equal(submitted.status, 409);
        assert.equal(submitted.body.code, 'mode_changed');
        assert.equal(submitted.body.game_mode, 'brutal');
    });

    test('a negative round score is stored and counted', async () => {
        const { roomId } = await playingRoom();

        const submitted = await action('ann', roomId, 'submit-score', score(-5));

        assert.equal(submitted.status, 200);
        assert.equal((await readTotals(roomId)).ann, -5);
    });

    // --- The attack ------------------------------------------------------

    test('an attack is stored and takes 15 from the target, not the attacker', async () => {
        const { roomId, ids } = await playingRoom();

        const submitted = await action('ann', roomId, 'submit-score', attack(ids.ben));

        assert.equal(submitted.status, 200);
        assert.equal(submitted.body.round_score.flip7_attack_player_id, ids.ben);
        assert.deepEqual(await readTotals(roomId), { host: 0, ann: SEVEN_SUM, ben: -15 });
    });

    test('a score without an attack stores none, and null means none', async () => {
        const { roomId } = await playingRoom();

        const plain = await action('ann', roomId, 'submit-score', score(5));
        const withNull = await action('ben', roomId, 'submit-score', score(6, { flip7_attack_player_id: null }));

        assert.equal(plain.body.round_score.flip7_attack_player_id, null);
        assert.equal(withNull.status, 200);
        assert.equal(withNull.body.round_score.flip7_attack_player_id, null);
    });

    test('seven different numbers with a repeat can only attack with the override on', async () => {
        const { roomId, ids } = await playingRoom();
        const cards = numberCards([1, 1, 2, 3, 4, 5, 6, 7]);

        const refused = await action('ann', roomId, 'submit-score', attack(ids.ben, { cards }));
        assert.equal(refused.status, 400);
        assert.deepEqual(await readTotals(roomId), { host: 0, ann: 0, ben: 0 });

        const vouched = await action('ann', roomId, 'submit-score', attack(ids.ben, { cards, duplicate_allowed: true }));
        assert.equal(vouched.status, 200);
        assert.equal((await readTotals(roomId)).ben, -15);
    });

    test('submit order does not matter: the target scoring later still loses 15', async () => {
        const { roomId, ids } = await playingRoom();

        await action('ann', roomId, 'submit-score', attack(ids.ben));
        await action('ben', roomId, 'submit-score', score(20));

        assert.equal((await readTotals(roomId)).ben, 5);
    });

    test('submit order does not matter: a target who already scored loses 15', async () => {
        const { roomId, ids } = await playingRoom();

        await action('ben', roomId, 'submit-score', score(20));
        await action('ann', roomId, 'submit-score', attack(ids.ben));

        assert.equal((await readTotals(roomId)).ben, 5);
    });

    test('a busted target is valid and goes below 0', async () => {
        const { roomId, ids } = await playingRoom();
        await action('ben', roomId, 'submit-score', score(0, { cards: [], busted: true }));

        const submitted = await action('ann', roomId, 'submit-score', attack(ids.ben));

        assert.equal(submitted.status, 200);
        assert.equal((await readTotals(roomId)).ben, -15);
    });

    test('two attacks on one player both count', async () => {
        const { roomId, ids } = await playingRoom();

        await action('ann', roomId, 'submit-score', attack(ids.ben));
        await action('host', roomId, 'submit-score', attack(ids.ben));

        assert.equal((await readTotals(roomId)).ben, -30);
    });

    test('Lucky 13 and the 13 it allows make up a seven-card hand', async () => {
        const { roomId, ids } = await playingRoom();
        const cards = [{ value: '13', type: 'special' }, ...numberCards([13, 1, 2, 3, 4, 5])];

        const submitted = await action('ann', roomId, 'submit-score', attack(ids.ben, { cards }));

        assert.equal(submitted.status, 200);
    });

    test('a Flip 7 with minus cards and a plain 13 can attack', async () => {
        const { roomId, ids } = await playingRoom();
        const cards = [...numberCards([13, 1, 2, 3, 4, 5, 6]), { value: '4', type: 'subtractor' }];

        const submitted = await action('ann', roomId, 'submit-score', attack(ids.ben, { cards }));

        assert.equal(submitted.status, 200);
    });

    // parseInt reads it as nothing, and the scorer counts such a row as a 0.
    test('a value that doesn\'t read as a number still counts toward the seven, as in the scorer', async () => {
        const { roomId, ids } = await playingRoom();
        const cards = numberCards(['abc', 1, 2, 3, 4, 5, 6]);

        const submitted = await action('ann', roomId, 'submit-score', attack(ids.ben, { cards }));

        assert.equal(submitted.status, 200);
    });

    // Old data: the actions always store final_score, so only a direct entity write can leave it out.
    test('a stored score with no final_score counts as 0 in a total', async () => {
        const { roomId, ids } = await playingRoom();
        await api(baseUrl, 'POST', '/api/entities/RoundScore', {
            cookie: cookies.host,
            body: { room_id: roomId, player_id: ids.ben, round_number: 1, cards: [] },
        });

        await action('ann', roomId, 'submit-score', attack(ids.ben));

        assert.equal((await readTotals(roomId)).ben, -15);
    });

    // --- Refused attacks -------------------------------------------------

    const REFUSED_HANDS = [
        ['six numbers', { cards: numberCards([1, 2, 3, 4, 5, 6]) }],
        ['eight numbers', { cards: numberCards([1, 2, 3, 4, 5, 6, 7, 8]) }],
        ['seven rows with a blank one', { cards: numberCards([1, 2, 3, 4, 5, 6, '']) }],
        ['a Steal or Swap duplicate, which is six different numbers', {
            cards: numberCards([1, 2, 3, 4, 5, 6, 6]),
            duplicate_allowed: true,
        }],
        ['a declared bust with seven numbers', { busted: true }],
    ];

    for (const [description, fields] of REFUSED_HANDS) {
        test(`an attack is refused on ${description}`, async () => {
            const { roomId, ids } = await playingRoom();

            const submitted = await action('ann', roomId, 'submit-score', attack(ids.ben, fields));

            assert.equal(submitted.status, 400);
            assert.equal((await readTotals(roomId)).ben, 0);
        });
    }

    for (const gameMode of ['classic', 'vengeance']) {
        test(`an attack is refused in ${gameMode}`, async () => {
            const { roomId, ids } = await playingRoom({ gameMode });

            const submitted = await action('ann', roomId, 'submit-score', attack(ids.ben));

            assert.equal(submitted.status, 400);
        });
    }

    test('an attack on yourself is refused', async () => {
        const { roomId, ids } = await playingRoom();

        const submitted = await action('ann', roomId, 'submit-score', attack(ids.ann));

        assert.equal(submitted.status, 400);
    });

    test('an attack on someone not in the room is refused', async () => {
        const { roomId } = await playingRoom();

        const submitted = await action('ann', roomId, 'submit-score', attack('no-such-player'));

        assert.equal(submitted.status, 400);
    });

    for (const bad of ['', 7, true, {}]) {
        test(`an attack naming ${JSON.stringify(bad)} is refused`, async () => {
            const { roomId } = await playingRoom();

            const submitted = await action('ann', roomId, 'submit-score', attack(bad));

            assert.equal(submitted.status, 400);
        });
    }

    // --- Retries ---------------------------------------------------------

    test('a retry of an attack in the open round changes nothing', async () => {
        const { roomId, ids } = await playingRoom();

        await action('ann', roomId, 'submit-score', attack(ids.ben));
        const retried = await action('ann', roomId, 'submit-score', attack(ids.ben));

        assert.equal(retried.status, 200);
        assert.equal((await readTotals(roomId)).ben, -15);
    });

    test('a retry after the round closed is reported as applied, even with the target since kicked', async () => {
        const { roomId, ids } = await playingRoom();
        await closeRoundWithAttack(roomId, ids);
        await action('host', roomId, 'kick', { player_id: ids.ben });

        const retried = await action('ann', roomId, 'submit-score', attack(ids.ben));

        assert.equal(retried.status, 200);
        assert.equal(retried.body.already_applied, true);
    });

    test('a late submit naming another target is a round mismatch, not a retry', async () => {
        const { roomId, ids } = await playingRoom();
        await closeRoundWithAttack(roomId, ids);

        const late = await action('ann', roomId, 'submit-score', attack(ids.host));

        assert.equal(late.status, 409);
        assert.equal(late.body.code, 'round_mismatch');
        assert.equal(late.body.stored_score.flip7_attack_player_id, ids.ben);
    });

    test('a late submit leaving the attack out is a round mismatch, not a retry', async () => {
        const { roomId, ids } = await playingRoom();
        await closeRoundWithAttack(roomId, ids);

        const late = await action('ann', roomId, 'submit-score', attack(null));

        assert.equal(late.status, 409);
        assert.equal(late.body.code, 'round_mismatch');
    });

    // --- Whatever replaces or removes the attacker's score ---------------

    test('a re-submit that drops the attack gives the 15 back', async () => {
        const { roomId, ids } = await playingRoom();
        await action('ann', roomId, 'submit-score', attack(ids.ben));

        await action('ann', roomId, 'submit-score', score(SEVEN_SUM + 15));

        const totals = await readTotals(roomId);
        assert.equal(totals.ben, 0);
        assert.equal(totals.ann, SEVEN_SUM + 15);
    });

    test('a re-submit that changes the target moves the 15 to the new one', async () => {
        const { roomId, ids } = await playingRoom();
        await action('ann', roomId, 'submit-score', attack(ids.ben));

        await action('ann', roomId, 'submit-score', attack(ids.host));

        const totals = await readTotals(roomId);
        assert.equal(totals.ben, 0);
        assert.equal(totals.host, -15);
    });

    test('retract-score gives the 15 back, and its retry changes nothing', async () => {
        const { roomId, ids } = await playingRoom();
        await action('ann', roomId, 'submit-score', attack(ids.ben));

        const retracted = await action('ann', roomId, 'retract-score', { round_number: 1 });
        const retried = await action('ann', roomId, 'retract-score', { round_number: 1 });

        assert.equal(retracted.body.round_score.flip7_attack_player_id, ids.ben);
        assert.equal(retried.body.already_applied, true);
        assert.deepEqual(await readTotals(roomId), { host: 0, ann: 0, ben: 0 });
    });

    test('edit-score can add an attack to a closed round, judged by the score\'s owner', async () => {
        const { roomId, ids } = await playingRoom();
        for (const name of ['host', 'ann', 'ben']) {
            await action(name, roomId, 'submit-score', score(5));
        }
        await action('host', roomId, 'set-edit-mode', { on: true });

        // The host naming themselves is fine, as the score is ann's.
        const edited = await action('host', roomId, 'edit-score', { player_id: ids.ann, ...attack(ids.host) });

        assert.equal(edited.status, 200);
        assert.deepEqual(await readTotals(roomId), { host: -10, ann: SEVEN_SUM, ben: 5 });
    });

    test('edit-score refuses an attack on the score\'s owner', async () => {
        const { roomId, ids } = await playingRoom();
        await action('host', roomId, 'set-edit-mode', { on: true });

        const edited = await action('host', roomId, 'edit-score', { player_id: ids.ann, ...attack(ids.ann) });

        assert.equal(edited.status, 400);
    });

    test('edit-score that drops the attack, or moves it, recomputes every target', async () => {
        const { roomId, ids } = await playingRoom();
        await action('ann', roomId, 'submit-score', attack(ids.ben));
        await action('host', roomId, 'set-edit-mode', { on: true });

        await action('host', roomId, 'edit-score', { player_id: ids.ann, ...attack(ids.host) });
        let totals = await readTotals(roomId);
        assert.equal(totals.ben, 0);
        assert.equal(totals.host, -15);

        await action('host', roomId, 'edit-score', { player_id: ids.ann, ...score(5) });
        totals = await readTotals(roomId);
        assert.equal(totals.host, 0);
        assert.equal(totals.ann, 5);
    });

    test('the attacker leaving takes the −15 with them', async () => {
        const { roomId, ids } = await playingRoom();
        await action('ann', roomId, 'submit-score', attack(ids.ben));

        const left = await action('ann', roomId, 'leave');

        assert.equal(left.status, 200);
        assert.deepEqual(await readTotals(roomId), { host: 0, ben: 0 });
    });

    test('the attacker being kicked takes the −15 with them', async () => {
        const { roomId, ids } = await playingRoom();
        await action('ann', roomId, 'submit-score', attack(ids.ben));

        await action('host', roomId, 'kick', { player_id: ids.ann });

        assert.deepEqual(await readTotals(roomId), { host: 0, ben: 0 });
    });

    test('a kicked target\'s attack is ignored, and the attacker keeps their score', async () => {
        const { roomId, ids } = await playingRoom();
        await action('ann', roomId, 'submit-score', attack(ids.ben));

        const kicked = await action('host', roomId, 'kick', { player_id: ids.ben });

        assert.equal(kicked.status, 200);
        assert.deepEqual(await readTotals(roomId), { host: 0, ann: SEVEN_SUM });
        const stored = (await readScores(roomId)).find((entry) => entry.player_id === ids.ann);
        assert.equal(stored.flip7_attack_player_id, ids.ben);
    });

    test('someone rejoining after being kicked starts clean, as they are a new player', async () => {
        const { roomId, ids } = await playingRoom();
        await action('ann', roomId, 'submit-score', attack(ids.ben));
        await action('host', roomId, 'kick', { player_id: ids.ben });

        await action('ben', roomId, 'join', { name: 'ben' });
        await action('host', roomId, 'submit-score', score(1));

        assert.equal((await readTotals(roomId)).ben, 0);
    });

    test('a new attack on a kicked player is refused', async () => {
        const { roomId, ids } = await playingRoom();
        await action('host', roomId, 'kick', { player_id: ids.ben });

        const submitted = await action('ann', roomId, 'submit-score', attack(ids.ben));

        assert.equal(submitted.status, 400);
    });

    test('someone who is both a target and an attacker leaving settles every total', async () => {
        const { roomId, ids } = await playingRoom();
        await action('ann', roomId, 'submit-score', attack(ids.ben));
        await action('ben', roomId, 'submit-score', attack(ids.host));

        await action('ben', roomId, 'leave');

        assert.deepEqual(await readTotals(roomId), { host: 0, ann: SEVEN_SUM });
    });

    test('the last player leaving closes the room without a recompute going wrong', async () => {
        const { roomId, ids } = await playingRoom();
        await action('ann', roomId, 'submit-score', attack(ids.ben));

        await action('host', roomId, 'leave');
        await action('ben', roomId, 'leave');
        const last = await action('ann', roomId, 'leave');

        assert.equal(last.status, 200);
        assert.equal(last.body.room.status, 'closed');
    });

    // --- The end of the game --------------------------------------------

    test('a −15 that takes a player back under max_score stops the game ending', async () => {
        const { roomId, ids } = await playingRoom({ maxScore: 20 });
        await action('ben', roomId, 'submit-score', score(25));
        await action('host', roomId, 'submit-score', score(1));

        await action('ann', roomId, 'submit-score', attack(ids.ben, { final_score: 10 }));

        const room = await readRoom(roomId);
        assert.equal(room.status, 'playing');
        assert.equal(room.current_round, 2);
        assert.equal((await readTotals(roomId)).ben, 10);
    });

    test('without that −15 the same round ends the game', async () => {
        const { roomId } = await playingRoom({ maxScore: 20 });
        await action('ben', roomId, 'submit-score', score(25));
        await action('host', roomId, 'submit-score', score(1));

        await action('ann', roomId, 'submit-score', score(10));

        assert.equal((await readRoom(roomId)).status, 'finished');
    });

    test('an attack can change who wins', async () => {
        const { roomId, ids } = await playingRoom({ maxScore: 20 });
        await action('ben', roomId, 'submit-score', score(40));
        await action('host', roomId, 'submit-score', score(1));

        await action('ann', roomId, 'submit-score', attack(ids.ben, { final_score: 30 }));

        const room = await readRoom(roomId);
        assert.equal(room.status, 'finished');
        assert.equal(room.winner_player_id, ids.ann);
    });

    test('the attacker leaving can put a player back over max_score, and the round end goes by that', async () => {
        const { roomId, ids } = await playingRoom({ maxScore: 20 });
        await action('ben', roomId, 'submit-score', score(25));
        await action('ann', roomId, 'submit-score', attack(ids.ben, { final_score: 1 }));
        assert.equal((await readTotals(roomId)).ben, 10);

        await action('ann', roomId, 'leave');
        await action('host', roomId, 'submit-score', score(1));

        const room = await readRoom(roomId);
        assert.equal((await readTotals(roomId)).ben, 25);
        assert.equal(room.status, 'finished');
        assert.equal(room.winner_player_id, ids.ben);
    });

    // --- Force Next Round, Reopen Game and Play Again --------------------

    test('force-next-round keeps a −15 on a player it zeroes', async () => {
        const { roomId, ids } = await playingRoom();
        await action('ann', roomId, 'submit-score', attack(ids.ben));

        const forced = await action('host', roomId, 'force-next-round', { round_number: 1 });

        assert.equal(forced.status, 200);
        assert.equal(forced.body.room.current_round, 2);
        assert.deepEqual(await readTotals(roomId), { host: 0, ann: SEVEN_SUM, ben: -15 });
    });

    test('force-next-round reads totals after the −15, so it doesn\'t end the game', async () => {
        const { roomId, ids } = await playingRoom({ maxScore: 20 });
        await action('ben', roomId, 'submit-score', score(25));
        await action('ann', roomId, 'submit-score', attack(ids.ben, { final_score: 10 }));

        const forced = await action('host', roomId, 'force-next-round', { round_number: 1 });

        assert.equal(forced.body.room.status, 'playing');
        assert.equal(forced.body.room.current_round, 2);
    });

    test('reopen-game leaves the −15 standing, and Done Editing goes by it', async () => {
        const { roomId, ids } = await playingRoom({ maxScore: 20 });
        await action('ben', roomId, 'submit-score', score(40));
        await action('host', roomId, 'submit-score', score(1));
        await action('ann', roomId, 'submit-score', attack(ids.ben, { final_score: 1 }));
        assert.equal((await readRoom(roomId)).winner_player_id, ids.ben);
        const before = await readTotals(roomId);
        assert.equal(before.ben, 25);

        const reopened = await action('host', roomId, 'reopen-game');
        assert.equal(reopened.status, 200);
        assert.deepEqual(await readTotals(roomId), before);

        await action('host', roomId, 'edit-score', { player_id: ids.ben, ...score(30) });
        await action('host', roomId, 'set-edit-mode', { on: false });

        const room = await readRoom(roomId);
        assert.equal((await readTotals(roomId)).ben, 15);
        assert.equal(room.status, 'playing');
        assert.equal(room.current_round, 2);
    });

    test('a reopened game can take an attack back, and the game finishes again', async () => {
        const { roomId, ids } = await playingRoom({ maxScore: 20 });
        await action('ben', roomId, 'submit-score', score(40));
        await action('host', roomId, 'submit-score', score(1));
        await action('ann', roomId, 'submit-score', attack(ids.ben, { final_score: 1 }));

        await action('host', roomId, 'reopen-game');
        await action('host', roomId, 'edit-score', { player_id: ids.ann, ...score(1) });
        await action('host', roomId, 'set-edit-mode', { on: false });

        const room = await readRoom(roomId);
        assert.equal((await readTotals(roomId)).ben, 40);
        assert.equal(room.status, 'finished');
        assert.equal(room.winner_player_id, ids.ben);
    });

    test('an attacker leaving a finished game settles the totals and leaves the winner alone', async () => {
        const { roomId, ids } = await playingRoom({ maxScore: 20 });
        await action('ben', roomId, 'submit-score', score(40));
        await action('host', roomId, 'submit-score', score(1));
        await action('ann', roomId, 'submit-score', attack(ids.ben, { final_score: 1 }));

        await action('ann', roomId, 'leave');

        const room = await readRoom(roomId);
        assert.equal((await readTotals(roomId)).ben, 40);
        assert.equal(room.status, 'finished');
        assert.equal(room.winner_player_id, ids.ben);
    });

    test('play-again clears every attack and keeps the mode', async () => {
        const { roomId, ids } = await playingRoom({ maxScore: 20 });
        await action('ben', roomId, 'submit-score', score(40));
        await action('host', roomId, 'submit-score', score(1));
        await action('ann', roomId, 'submit-score', attack(ids.ben, { final_score: 1 }));

        const again = await action('host', roomId, 'play-again');
        await action('host', roomId, 'start');

        assert.equal(again.body.room.game_mode, 'brutal');
        assert.deepEqual(await readTotals(roomId), { host: 0, ann: 0, ben: 0 });
        assert.deepEqual(await readScores(roomId), []);
    });

    // --- A busted player's minus cards ----------------------------------

    test('a bust can be re-submitted with a minus card, still busted', async () => {
        const { roomId, ids } = await playingRoom();
        await action('ann', roomId, 'submit-score', score(0, { cards: [], busted: true }));
        const minusCard = [{ value: '6', type: 'subtractor' }];

        const again = await action('ann', roomId, 'submit-score', score(-6, { cards: minusCard, base_sum: 0, busted: true }));

        assert.equal(again.status, 200);
        assert.equal(again.body.round_score.busted, true);
        assert.equal((await readTotals(roomId)).ann, -6);
        assert.equal((await readScores(roomId)).filter((entry) => entry.player_id === ids.ann).length, 1);
    });
});
