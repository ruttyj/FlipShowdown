import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, devLogin, startTestServer } from './helpers.js';

// Turn rotation: the first dealer is the player first in turn order (the host
// sets it with reorder), and each completed round passes the deal to the next
// player, wrapping around.

describe('turn rotation', () => {
    let server;
    let baseUrl;
    const cookies = {};
    const NAMES = ['host', 'ann', 'ben'];

    before(async () => {
        server = await startTestServer();
        baseUrl = server.baseUrl;
        for (const name of NAMES) {
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

    function playerId(snapshot, name) {
        return snapshot.players.find((player) => player.email === `${name}@example.com`).id;
    }

    function dealerName(snapshot) {
        const dealer = snapshot.players.find((player) => player.id === snapshot.room.current_turn_player_id);
        return dealer.email.split('@')[0];
    }

    /** A waiting room with host, ann and ben. Returns the snapshot. */
    async function waitingRoom() {
        const created = await api(baseUrl, 'POST', '/api/rooms', {
            cookie: cookies.host,
            body: { max_score: 500 },
        });
        const roomId = created.body.room.id;
        await action('ann', roomId, 'join', { name: 'ann' });
        const joined = await action('ben', roomId, 'join', { name: 'ben' });
        return joined.body;
    }

    /** Everyone scores 0 for `round`. Returns the last response's snapshot. */
    async function playRound(roomId, round) {
        let last;
        for (const name of NAMES) {
            last = await action(name, roomId, 'submit-score', {
                round_number: round,
                cards: [{ value: '0', type: 'number' }],
                base_sum: 0,
                final_score: 0,
            });
            assert.equal(last.status, 200, JSON.stringify(last.body));
        }
        return last.body;
    }

    /** Plays `rounds` rounds and returns the dealer of each round, starting with round 1. */
    async function dealersOverRounds(started, rounds) {
        const roomId = started.room.id;
        const dealers = [dealerName(started)];
        for (let round = 1; round < rounds; round++) {
            const snapshot = await playRound(roomId, round);
            assert.equal(snapshot.room.current_round, round + 1);
            dealers.push(dealerName(snapshot));
        }
        return dealers;
    }

    // --- Tests -----------------------------------------------------------

    test('the deal rotates through the turn order and wraps', async () => {
        const waiting = await waitingRoom();
        const started = await action('host', waiting.room.id, 'start');

        const dealers = await dealersOverRounds(started.body, 5);
        assert.deepEqual(dealers, ['host', 'ann', 'ben', 'host', 'ann']);
    });

    test('a reorder before start makes that player the first dealer', async () => {
        const waiting = await waitingRoom();
        const order = [playerId(waiting, 'ann'), playerId(waiting, 'ben'), playerId(waiting, 'host')];
        const reordered = await action('host', waiting.room.id, 'reorder', { player_ids: order });
        assert.equal(reordered.status, 200);
        const started = await action('host', waiting.room.id, 'start');

        const dealers = await dealersOverRounds(started.body, 5);
        assert.deepEqual(dealers, ['ann', 'ben', 'host', 'ann', 'ben']);
    });

    test('play-again then start deals first to the flagged first player again', async () => {
        const waiting = await waitingRoom();
        const roomId = waiting.room.id;
        const order = [playerId(waiting, 'ben'), playerId(waiting, 'host'), playerId(waiting, 'ann')];
        await action('host', roomId, 'reorder', { player_ids: order });
        const first = await action('host', roomId, 'start');
        await dealersOverRounds(first.body, 3);

        const ended = await action('host', roomId, 'end-game');
        assert.equal(ended.status, 200, JSON.stringify(ended.body));
        assert.equal(ended.body.room.status, 'finished');

        const again = await action('host', roomId, 'play-again');
        assert.equal(again.status, 200, JSON.stringify(again.body));
        const second = await action('host', roomId, 'start');
        assert.equal(second.status, 200, JSON.stringify(second.body));

        const dealers = await dealersOverRounds(second.body, 4);
        assert.deepEqual(dealers, ['ben', 'host', 'ann', 'ben']);
    });
});
