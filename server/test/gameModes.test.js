import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { roomGameMode } from '../src/gameModes.js';
import { api, devLogin, startTestServer } from './helpers.js';

describe('game modes (X41)', () => {
    let server;
    let baseUrl;
    const cookies = {};

    before(async () => {
        server = await startTestServer({ env: { ADMIN_EMAILS: 'boss@example.com' } });
        baseUrl = server.baseUrl;
        for (const name of ['host', 'ann', 'boss', 'outsider']) {
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

    function createRoom(body = {}) {
        return api(baseUrl, 'POST', '/api/rooms', { cookie: cookies.host, body: { max_score: 200, ...body } });
    }

    async function waitingRoom(body) {
        const created = await createRoom(body);
        assert.equal(created.status, 200);
        const roomId = created.body.room.id;
        await action('ann', roomId, 'join', { name: 'ann' });
        return roomId;
    }

    async function playingRoom(body) {
        const roomId = await waitingRoom(body);
        const started = await action('host', roomId, 'start');
        assert.equal(started.status, 200);
        return roomId;
    }

    function score(fields = {}) {
        return { round_number: 1, cards: [{ value: '5', type: 'number' }], base_sum: 5, final_score: 5, ...fields };
    }

    async function readRoom(roomId) {
        const response = await api(baseUrl, 'GET', `/api/entities/GameRoom/${roomId}`, { cookie: cookies.host });
        return response.body;
    }

    function playerId(snapshot, name) {
        return snapshot.players.find((player) => player.email === `${name}@example.com`).id;
    }

    // --- Create ----------------------------------------------------------

    test('a room with no mode is classic', async () => {
        const created = await createRoom();

        assert.equal(created.body.room.game_mode, 'classic');
    });

    test('a room can be created in a chosen mode', async () => {
        const created = await createRoom({ game_mode: 'vengeance' });

        assert.equal(created.status, 200);
        assert.equal(created.body.room.game_mode, 'vengeance');
    });

    for (const bad of ['nonsense', '', 7, null]) {
        test(`creating with game_mode ${JSON.stringify(bad)} is a bad request`, async () => {
            const created = await createRoom({ game_mode: bad });

            assert.equal(created.status, 400);
            assert.equal(created.body.code, 'bad_request');
        });
    }

    test('the join screen lookup exposes the mode', async () => {
        const created = await createRoom({ game_mode: 'vengeance' });

        const lookup = await api(baseUrl, 'GET', `/api/rooms/by-code/${created.body.room.code}`, { cookie: cookies.ann });

        assert.equal(lookup.body.room.game_mode, 'vengeance');
    });

    // --- set-game-mode -----------------------------------------------------

    test('the host can change the mode while waiting', async () => {
        const roomId = await waitingRoom();
        const before = await readRoom(roomId);

        const changed = await action('host', roomId, 'set-game-mode', { game_mode: 'vengeance' });

        assert.equal(changed.status, 200);
        assert.equal(changed.body.room.game_mode, 'vengeance');
        assert.equal(changed.body.room.version, before.version + 1);
    });

    test('the host can change the mode while playing, until the first score', async () => {
        const roomId = await playingRoom();

        const changed = await action('host', roomId, 'set-game-mode', { game_mode: 'vengeance' });

        assert.equal(changed.status, 200);
        assert.equal(changed.body.room.game_mode, 'vengeance');
    });

    test('setting the mode it already has changes nothing, so a retry is safe', async () => {
        const roomId = await waitingRoom({ game_mode: 'vengeance' });
        const before = await readRoom(roomId);

        const repeated = await action('host', roomId, 'set-game-mode', { game_mode: 'vengeance' });

        assert.equal(repeated.status, 200);
        assert.equal(repeated.body.room.version, before.version);
    });

    test('a retry after someone scored still answers ok for the mode already set', async () => {
        const roomId = await playingRoom({ game_mode: 'vengeance' });
        await action('ann', roomId, 'submit-score', score());

        const repeated = await action('host', roomId, 'set-game-mode', { game_mode: 'vengeance' });

        assert.equal(repeated.status, 200);
    });

    test('a score from submit-score locks the mode', async () => {
        const roomId = await playingRoom();
        await action('ann', roomId, 'submit-score', score());

        const locked = await action('host', roomId, 'set-game-mode', { game_mode: 'vengeance' });

        assert.equal(locked.status, 409);
        assert.equal(locked.body.code, 'mode_locked');
        assert.equal((await readRoom(roomId)).game_mode, 'classic');
    });

    test('a score from edit-score locks the mode', async () => {
        const roomId = await playingRoom();
        const started = await readRoom(roomId);
        const { body: snapshot } = await action('host', started.id, 'set-edit-mode', { on: true });
        await action('host', roomId, 'edit-score', { player_id: playerId(snapshot, 'ann'), ...score() });

        const locked = await action('host', roomId, 'set-game-mode', { game_mode: 'vengeance' });

        assert.equal(locked.status, 409);
        assert.equal(locked.body.code, 'mode_locked');
    });

    test('a zero from force-next-round locks the mode', async () => {
        const roomId = await playingRoom();
        await action('host', roomId, 'force-next-round', { round_number: 1 });

        const locked = await action('host', roomId, 'set-game-mode', { game_mode: 'vengeance' });

        assert.equal(locked.status, 409);
        assert.equal(locked.body.code, 'mode_locked');
    });

    test('a finished game is locked until Play Again, which keeps the mode', async () => {
        const roomId = await playingRoom({ game_mode: 'vengeance' });
        await action('host', roomId, 'end-game');

        const locked = await action('host', roomId, 'set-game-mode', { game_mode: 'classic' });
        assert.equal(locked.status, 409);
        assert.equal(locked.body.code, 'mode_locked');

        const rematch = await action('host', roomId, 'play-again');
        assert.equal(rematch.body.room.game_mode, 'vengeance');

        const changed = await action('host', roomId, 'set-game-mode', { game_mode: 'classic' });
        assert.equal(changed.status, 200);
    });

    test('a closed room has the wrong status', async () => {
        const roomId = await waitingRoom();
        await action('host', roomId, 'close');

        const closed = await action('host', roomId, 'set-game-mode', { game_mode: 'vengeance' });

        assert.equal(closed.status, 409);
        assert.equal(closed.body.code, 'wrong_status');
    });

    for (const bad of ['nonsense', undefined, 7]) {
        test(`set-game-mode with ${JSON.stringify(bad)} is a bad request`, async () => {
            const roomId = await waitingRoom();

            const changed = await action('host', roomId, 'set-game-mode', { game_mode: bad });

            assert.equal(changed.status, 400);
            assert.equal(changed.body.code, 'bad_request');
        });
    }

    test('only the host, an admin or a new host can change the mode', async () => {
        const roomId = await waitingRoom();

        const guest = await action('ann', roomId, 'set-game-mode', { game_mode: 'vengeance' });
        assert.equal(guest.status, 403);
        assert.equal(guest.body.code, 'not_host');

        const admin = await action('boss', roomId, 'set-game-mode', { game_mode: 'vengeance' });
        assert.equal(admin.status, 200);

        const { body: snapshot } = await action('host', roomId, 'make-host', {
            player_id: (await api(baseUrl, 'GET', `/api/entities/Player?q=${encodeURIComponent(JSON.stringify({ room_id: roomId, email: 'ann@example.com' }))}`, { cookie: cookies.host })).body[0].id,
        });
        assert.equal(snapshot.room.host_email, 'ann@example.com');
        const newHost = await action('ann', roomId, 'set-game-mode', { game_mode: 'classic' });
        assert.equal(newHost.status, 200);
    });

    // --- The mode_changed guard --------------------------------------------

    test('a score worked out under another mode is refused and nothing is stored', async () => {
        const roomId = await playingRoom();
        await action('host', roomId, 'set-game-mode', { game_mode: 'vengeance' });

        const submitted = await action('ann', roomId, 'submit-score', score({ game_mode: 'classic' }));

        assert.equal(submitted.status, 409);
        assert.equal(submitted.body.code, 'mode_changed');
        assert.equal(submitted.body.game_mode, 'vengeance');
        const stored = await api(baseUrl, 'GET', `/api/entities/RoundScore?q=${encodeURIComponent(JSON.stringify({ room_id: roomId }))}`, { cookie: cookies.host });
        assert.deepEqual(stored.body, []);
    });

    test('edit-score is guarded the same way', async () => {
        const roomId = await playingRoom();
        const { body: snapshot } = await action('host', roomId, 'set-game-mode', { game_mode: 'vengeance' });

        const edited = await action('host', roomId, 'edit-score', {
            player_id: playerId(snapshot, 'ann'),
            ...score({ game_mode: 'classic' }),
        });

        assert.equal(edited.status, 409);
        assert.equal(edited.body.code, 'mode_changed');
    });

    test('a matching mode is accepted and never stored', async () => {
        const roomId = await playingRoom({ game_mode: 'vengeance' });

        const submitted = await action('ann', roomId, 'submit-score', score({ game_mode: 'vengeance' }));

        assert.equal(submitted.status, 200);
        assert.equal('game_mode' in submitted.body.round_score, false);
    });

    test('a client that sends no mode is not checked', async () => {
        const roomId = await playingRoom({ game_mode: 'vengeance' });

        const submitted = await action('ann', roomId, 'submit-score', score());

        assert.equal(submitted.status, 200);
    });

    test('a special card is stored like any other card', async () => {
        const roomId = await playingRoom({ game_mode: 'vengeance' });
        const cards = [{ value: '13', type: 'special' }];

        const submitted = await action('ann', roomId, 'submit-score', score({ cards, base_sum: 13, final_score: 13 }));

        assert.deepEqual(submitted.body.round_score.cards, cards);
    });

    // --- Old rooms ---------------------------------------------------------

    test('roomGameMode reads a missing or unknown stored mode as classic', () => {
        assert.equal(roomGameMode({}), 'classic');
        assert.equal(roomGameMode({ game_mode: 'gone' }), 'classic');
        assert.equal(roomGameMode({ game_mode: 'vengeance' }), 'vengeance');
    });

    test('a room stored without the field takes a classic score and can change mode', async () => {
        const roomId = await playingRoom();
        // Stored before the field existed, through the unlocked generic entity API.
        await api(baseUrl, 'PUT', `/api/entities/GameRoom/${roomId}`, { cookie: cookies.boss, body: { game_mode: null } });

        const refused = await action('ann', roomId, 'submit-score', score({ game_mode: 'vengeance' }));
        assert.equal(refused.body.code, 'mode_changed');
        assert.equal(refused.body.game_mode, 'classic');

        const changed = await action('host', roomId, 'set-game-mode', { game_mode: 'vengeance' });
        assert.equal(changed.status, 200);
    });
});
