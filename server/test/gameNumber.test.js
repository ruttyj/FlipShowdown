// Room.game_number: 1 on create, +1 on each play-again (X5). The client
// keys its saved score drafts by it, so a draft never comes back in a later game.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, devLogin, startTestServer } from './helpers.js';

describe('room game number', () => {
    let server;
    let baseUrl;
    const cookies = {};

    before(async () => {
        server = await startTestServer();
        baseUrl = server.baseUrl;
        for (const name of ['host', 'ann']) {
            cookies[name] = await devLogin(baseUrl, `${name}@example.com`, name);
        }
    });

    after(async () => {
        await server.stop();
    });

    // --- Helpers ---------------------------------------------------------

    async function action(who, roomId, name, body = {}) {
        const response = await api(baseUrl, 'POST', `/api/rooms/${roomId}/actions/${name}`, {
            cookie: cookies[who],
            body,
        });
        assert.equal(response.status, 200, `${name} failed: ${JSON.stringify(response.body)}`);
        return response.body;
    }

    async function createRoom() {
        const response = await api(baseUrl, 'POST', '/api/rooms', { cookie: cookies.host, body: { max_score: 20 } });
        assert.equal(response.status, 200);
        return response.body;
    }

    async function readRoom(roomId) {
        const response = await api(baseUrl, 'GET', `/api/entities/GameRoom/${roomId}`, { cookie: cookies.host });
        return response.body;
    }

    function playerId(snapshot, name) {
        return snapshot.players.find((player) => player.email === `${name}@example.com`).id;
    }

    /** Both players score 25 in round 1, which passes max_score 20 and finishes the game. */
    async function finishGame(roomId) {
        await action('host', roomId, 'start');
        const score = { round_number: 1, cards: [{ value: '25', type: 'number' }], base_sum: 25, final_score: 25 };
        await action('host', roomId, 'submit-score', score);
        const finished = await action('ann', roomId, 'submit-score', score);
        assert.equal(finished.room.status, 'finished');
        return finished;
    }

    /** A room with host and ann whose first game has finished. */
    async function finishedRoom() {
        const created = await createRoom();
        const roomId = created.room.id;
        await action('ann', roomId, 'join', { name: 'ann' });
        await finishGame(roomId);
        return roomId;
    }

    // --- Tests -----------------------------------------------------------

    test('a new room starts at game 1', async () => {
        const created = await createRoom();

        assert.equal(created.room.game_number, 1);
        assert.equal((await readRoom(created.room.id)).game_number, 1);
    });

    test('each play-again moves to the next game', async () => {
        const roomId = await finishedRoom();

        const second = await action('host', roomId, 'play-again');
        assert.equal(second.room.game_number, 2);

        await finishGame(roomId);
        const third = await action('host', roomId, 'play-again');
        assert.equal(third.room.game_number, 3);
        assert.equal((await readRoom(roomId)).game_number, 3);
    });

    test('actions other than play-again leave the game number alone', async () => {
        const created = await createRoom();
        const roomId = created.room.id;
        const joined = await action('ann', roomId, 'join', { name: 'ann' });
        const annId = playerId(joined, 'ann');

        const snapshots = [
            joined,
            await action('host', roomId, 'set-games-won', { wins: { [annId]: 1 } }),
            await action('host', roomId, 'start'),
            await action('ann', roomId, 'submit-score', {
                round_number: 1,
                cards: [{ value: '5', type: 'number' }],
                base_sum: 5,
                final_score: 5,
            }),
            await action('host', roomId, 'force-next-round', { round_number: 1 }),
            await action('host', roomId, 'set-edit-mode', { on: true }),
            await action('host', roomId, 'set-edit-mode', { on: false }),
            await action('host', roomId, 'end-game'),
        ];

        for (const snapshot of snapshots) {
            assert.equal(snapshot.room.game_number, 1);
        }
        assert.equal((await readRoom(roomId)).game_number, 1);
    });

    test('a room saved before game numbers existed counts as game 1 and plays again to game 2', async () => {
        const roomId = await finishedRoom();
        // Writing undefined clears the field, which then reads as null, as in an old row.
        server.instance.store.updateRecord('GameRoom', roomId, { game_number: undefined });
        assert.equal((await readRoom(roomId)).game_number, null);

        const again = await action('host', roomId, 'play-again');

        assert.equal(again.room.game_number, 2);
    });
});
