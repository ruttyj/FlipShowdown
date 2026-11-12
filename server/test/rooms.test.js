import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { runRoomAction } from '../src/gameActions/roomTx.js';
import { api, devLogin, silentLogger, startTestServer } from './helpers.js';

const CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

describe('room lifecycle actions', () => {
    let server;
    let baseUrl;
    const cookies = {};
    let published = [];

    before(async () => {
        server = await startTestServer({ env: { ADMIN_EMAILS: 'boss@example.com' } });
        baseUrl = server.baseUrl;
        for (const name of ['host', 'ann', 'ben', 'cat', 'outsider', 'boss']) {
            cookies[name] = await devLogin(baseUrl, `${name}@example.com`, name);
        }

        // Record every published event (with its options) and still deliver it.
        // hub.publish goes through publishAll too.
        const hub = server.instance.hub;
        const originalPublishAll = hub.publishAll.bind(hub);
        hub.publishAll = (events, options) => {
            for (const { entity, type, record } of events) {
                published.push({ entity, type, record, options });
            }
            originalPublishAll(events, options);
        };
    });

    after(async () => {
        await server.stop();
    });

    beforeEach(() => {
        published = [];
    });

    // --- Helpers ---------------------------------------------------------

    function action(who, roomId, name, body = {}) {
        return api(baseUrl, 'POST', `/api/rooms/${roomId}/actions/${name}`, { cookie: cookies[who], body });
    }

    async function createRoom(who = 'host', body = { max_score: 200 }) {
        const response = await api(baseUrl, 'POST', '/api/rooms', { cookie: cookies[who], body });
        assert.equal(response.status, 200);
        return response.body;
    }

    /** A room created by `host` with the other names joined in order. */
    async function roomWith(...joiners) {
        const created = await createRoom();
        let latest = created;
        for (const name of joiners) {
            latest = (await action(name, created.room.id, 'join', { name })).body;
        }
        return latest;
    }

    function playerOf(snapshot, name) {
        return snapshot.players.find((player) => player.email === `${name}@example.com`);
    }

    async function entity(name, id) {
        return api(baseUrl, 'GET', `/api/entities/${name}/${id}`, { cookie: cookies.host });
    }

    async function createEntity(name, body) {
        const response = await api(baseUrl, 'POST', `/api/entities/${name}`, { cookie: cookies.host, body });
        return response.body;
    }

    async function putEntity(name, id, body) {
        await api(baseUrl, 'PUT', `/api/entities/${name}/${id}`, { cookie: cookies.host, body });
    }

    function summarise(events) {
        return events.map((event) => `${event.type} ${event.entity}`);
    }

    // --- Create and lookup -----------------------------------------------

    test('create makes a waiting room with the caller as host player', async () => {
        const created = await createRoom('host', { max_score: 150 });
        const { room, players, player } = created;

        assert.match(room.code, CODE_PATTERN);
        assert.equal(room.status, 'waiting');
        assert.equal(room.host_email, 'host@example.com');
        assert.equal(room.host_player_id, player.id);
        assert.equal(room.max_score, 150);
        assert.equal(room.current_round, 1);
        assert.equal(room.version, 1);
        assert.equal(typeof room.last_activity_date, 'string');

        assert.equal(player.name, 'host');
        assert.equal(player.turn_order, 0);
        assert.equal(player.is_host, true);
        assert.deepEqual(players, [player]);

        assert.deepEqual(summarise(published), ['create Player', 'create GameRoom']);
        assert.equal(published[1].options.roomVersion, 1);
    });

    test('create validates max_score and needs a session', async () => {
        const bad = await api(baseUrl, 'POST', '/api/rooms', { cookie: cookies.host, body: { max_score: 'x' } });
        assert.equal(bad.status, 400);
        assert.equal(bad.body.code, 'bad_request');

        const anonymous = await api(baseUrl, 'POST', '/api/rooms', { body: { max_score: 10 } });
        assert.equal(anonymous.status, 401);
    });

    test('by-code lookup shows names only and the caller\'s own player', async () => {
        const snapshot = await roomWith('ann');
        const code = snapshot.room.code;

        const outsider = await api(baseUrl, 'GET', `/api/rooms/by-code/${code.toLowerCase()}`, {
            cookie: cookies.outsider,
        });
        assert.equal(outsider.status, 200);
        assert.equal(outsider.body.room.id, snapshot.room.id);
        assert.equal(outsider.body.my_player, null);
        assert.doesNotMatch(JSON.stringify(outsider.body), /@example\.com/);
        for (const player of outsider.body.players) {
            assert.deepEqual(Object.keys(player).sort(), ['id', 'is_host', 'name', 'turn_order']);
        }

        const member = await api(baseUrl, 'GET', `/api/rooms/by-code/${code}`, { cookie: cookies.ann });
        assert.equal(member.body.my_player.id, playerOf(snapshot, 'ann').id);

        await action('host', snapshot.room.id, 'close');
        const closed = await api(baseUrl, 'GET', `/api/rooms/by-code/${code}`, { cookie: cookies.ann });
        assert.equal(closed.status, 404);
        assert.equal(closed.body.code, 'room_not_found');
    });

    // --- Join ------------------------------------------------------------

    test('join adds a player with the next turn order', async () => {
        const created = await createRoom();
        const joined = await action('ann', created.room.id, 'join', { name: 'Ann' });

        assert.equal(joined.status, 200);
        assert.equal(joined.body.already_joined, false);
        assert.equal(joined.body.player.name, 'Ann');
        assert.equal(joined.body.player.turn_order, 1);
        assert.equal(joined.body.player.is_host, false);
        assert.equal(joined.body.room.version, 2);
        assert.deepEqual(joined.body.players.map((player) => player.turn_order), [0, 1]);
    });

    test('joining twice with the same email keeps one player', async () => {
        const created = await createRoom();
        const secondBrowser = await devLogin(baseUrl, 'ann@example.com', 'Ann');

        const first = await action('ann', created.room.id, 'join', { name: 'Ann' });
        published = [];
        const second = await api(baseUrl, 'POST', `/api/rooms/${created.room.id}/actions/join`, {
            cookie: secondBrowser,
            body: { name: 'Other name' },
        });

        assert.equal(second.status, 200);
        assert.equal(second.body.already_joined, true);
        assert.deepEqual(second.body.player, first.body.player);
        assert.equal(second.body.players.length, 2);
        assert.equal(second.body.room.version, first.body.room.version);
        assert.deepEqual(published, []);
    });

    test('signing in with another spelling of the email is the same player', async () => {
        const created = await createRoom();
        const shouting = await devLogin(baseUrl, ' Ann@Example.COM ', 'Ann');

        const first = await action('ann', created.room.id, 'join', { name: 'Ann' });
        const second = await api(baseUrl, 'POST', `/api/rooms/${created.room.id}/actions/join`, {
            cookie: shouting,
            body: { name: 'Ann' },
        });

        assert.equal(second.status, 200);
        assert.equal(second.body.already_joined, true);
        assert.equal(second.body.player.id, first.body.player.id);
        const found = await api(baseUrl, 'GET', `/api/rooms/by-code/${created.room.code}`, { cookie: shouting });
        assert.equal(found.body.my_player.id, first.body.player.id);
    });

    test('concurrent joins get distinct turn orders', async () => {
        const created = await createRoom();
        const joiners = ['ann', 'ben', 'cat', 'outsider', 'boss'];
        const responses = await Promise.all(
            joiners.map((name) => action(name, created.room.id, 'join', { name })),
        );

        const turnOrders = responses.map((response) => response.body.player.turn_order);
        assert.equal(new Set(turnOrders).size, joiners.length);
        assert.deepEqual([...turnOrders].sort(), [1, 2, 3, 4, 5]);
    });

    test('join validates the name and rejects closed rooms', async () => {
        const created = await createRoom();
        const noName = await action('ann', created.room.id, 'join', {});
        assert.equal(noName.status, 400);

        await action('host', created.room.id, 'close');
        const closed = await action('ann', created.room.id, 'join', { name: 'Ann' });
        assert.equal(closed.status, 409);
        assert.equal(closed.body.code, 'wrong_status');
        assert.equal(closed.body.status, 'closed');

        const missing = await action('ann', 'no-such-room', 'join', { name: 'Ann' });
        assert.equal(missing.status, 404);
        assert.equal(missing.body.code, 'room_not_found');
    });

    // --- Permissions -----------------------------------------------------

    test('host actions reject members (not_host) and outsiders (not_member)', async () => {
        const snapshot = await roomWith('ann', 'ben');
        const roomId = snapshot.room.id;
        const benId = playerOf(snapshot, 'ben').id;
        const hostActions = [
            ['kick', { player_id: benId }],
            ['make-host', { player_id: benId }],
            ['reorder', { player_ids: snapshot.players.map((player) => player.id) }],
            ['start', {}],
            ['close', {}],
            ['delete', {}],
        ];

        for (const [name, body] of hostActions) {
            const asMember = await action('ann', roomId, name, body);
            assert.equal(asMember.status, 403, name);
            assert.equal(asMember.body.code, 'not_host', name);

            const asOutsider = await action('outsider', roomId, name, body);
            assert.equal(asOutsider.status, 403, name);
            assert.equal(asOutsider.body.code, 'not_member', name);
        }

        const room = await entity('GameRoom', roomId);
        assert.equal(room.body.status, 'waiting');
        assert.equal(room.body.version, snapshot.room.version);
    });

    test('leave by a non-member is player_not_found, including admins', async () => {
        const snapshot = await roomWith('ann');

        const outsider = await action('outsider', snapshot.room.id, 'leave');
        assert.equal(outsider.status, 404);
        assert.equal(outsider.body.code, 'player_not_found');

        const admin = await action('boss', snapshot.room.id, 'leave');
        assert.equal(admin.status, 404);
        assert.equal(admin.body.code, 'player_not_found');
    });

    test('an admin without a player passes host checks', async () => {
        const snapshot = await roomWith('ann', 'ben');
        const roomId = snapshot.room.id;

        const madeHost = await action('boss', roomId, 'make-host', { player_id: playerOf(snapshot, 'ann').id });
        assert.equal(madeHost.status, 200);
        assert.equal(madeHost.body.room.host_email, 'ann@example.com');

        const kicked = await action('boss', roomId, 'kick', { player_id: playerOf(snapshot, 'ben').id });
        assert.equal(kicked.status, 200);
        assert.equal(kicked.body.players.length, 2);

        const started = await action('boss', roomId, 'start');
        assert.equal(started.status, 200);
        assert.equal(started.body.room.status, 'playing');

        const deleted = await action('boss', roomId, 'delete');
        assert.equal(deleted.status, 200);
    });

    // --- Status checks ---------------------------------------------------

    test('start and reorder only work while waiting', async () => {
        const snapshot = await roomWith('ann');
        const roomId = snapshot.room.id;
        const ids = snapshot.players.map((player) => player.id);

        assert.equal((await action('host', roomId, 'start')).status, 200);

        const again = await action('host', roomId, 'start');
        assert.equal(again.status, 409);
        assert.equal(again.body.code, 'wrong_status');
        assert.equal(again.body.status, 'playing');

        const reorder = await action('host', roomId, 'reorder', { player_ids: ids });
        assert.equal(reorder.status, 409);
        assert.equal(reorder.body.code, 'wrong_status');
    });

    test('closed rooms reject leave, kick and make-host but allow close and delete', async () => {
        const snapshot = await roomWith('ann');
        const roomId = snapshot.room.id;
        const annId = playerOf(snapshot, 'ann').id;

        const closed = await action('host', roomId, 'close');
        assert.equal(closed.body.room.status, 'closed');

        for (const [who, name, body] of [
            ['ann', 'leave', {}],
            ['host', 'kick', { player_id: annId }],
            ['host', 'make-host', { player_id: annId }],
        ]) {
            const response = await action(who, roomId, name, body);
            assert.equal(response.status, 409, name);
            assert.equal(response.body.code, 'wrong_status', name);
        }

        published = [];
        const closedAgain = await action('host', roomId, 'close');
        assert.equal(closedAgain.status, 200);
        assert.equal(closedAgain.body.room.version, closed.body.room.version);
        assert.deepEqual(published, []);

        assert.equal((await action('host', roomId, 'delete')).status, 200);
    });

    // --- Reorder and make-host -------------------------------------------

    test('reorder sets turn order by index and validates the list', async () => {
        const snapshot = await roomWith('ann', 'ben');
        const roomId = snapshot.room.id;
        const [hostId, annId, benId] = snapshot.players.map((player) => player.id);

        const reordered = await action('host', roomId, 'reorder', { player_ids: [benId, hostId, annId] });
        assert.equal(reordered.status, 200);
        assert.deepEqual(reordered.body.players.map((player) => player.id), [benId, hostId, annId]);

        for (const playerIds of [[benId, hostId], [benId, hostId, hostId], [benId, hostId, 'nope'], 'x']) {
            const response = await action('host', roomId, 'reorder', { player_ids: playerIds });
            assert.equal(response.status, 400, JSON.stringify(playerIds));
        }
    });

    test('make-host moves hosting and clears edit mode', async () => {
        const snapshot = await roomWith('ann');
        const roomId = snapshot.room.id;
        const hostId = playerOf(snapshot, 'host').id;
        const annId = playerOf(snapshot, 'ann').id;
        await putEntity('GameRoom', roomId, { is_edit_mode: true, edit_mode_by: hostId });

        published = [];
        const response = await action('host', roomId, 'make-host', { player_id: annId });
        assert.equal(response.status, 200);
        assert.equal(response.body.room.host_email, 'ann@example.com');
        assert.equal(response.body.room.host_player_id, annId);
        assert.equal(response.body.room.is_edit_mode, false);
        assert.equal(response.body.room.edit_mode_by, null);
        assert.equal(playerOf(response.body, 'ann').is_host, true);
        assert.equal(playerOf(response.body, 'host').is_host, false);
        assert.deepEqual(summarise(published), ['update Player', 'update Player', 'update GameRoom']);

        // The old host is now an ordinary member.
        const oldHost = await action('host', roomId, 'make-host', { player_id: hostId });
        assert.equal(oldHost.body.code, 'not_host');

        published = [];
        const repeat = await action('ann', roomId, 'make-host', { player_id: annId });
        assert.equal(repeat.status, 200);
        assert.deepEqual(published, []);

        const missing = await action('ann', roomId, 'make-host', { player_id: 'nope' });
        assert.equal(missing.status, 404);
        assert.equal(missing.body.code, 'player_not_found');
    });

    // --- Leave and kick --------------------------------------------------

    test('leave deletes the player and their scores and moves the turn', async () => {
        const snapshot = await roomWith('ann', 'ben');
        const roomId = snapshot.room.id;
        const annId = playerOf(snapshot, 'ann').id;
        const benId = playerOf(snapshot, 'ben').id;
        await action('host', roomId, 'start');
        await putEntity('GameRoom', roomId, { current_turn_player_id: annId });
        const annScore = await createEntity('RoundScore', { room_id: roomId, player_id: annId, round_number: 1 });

        published = [];
        const response = await action('ann', roomId, 'leave');
        assert.equal(response.status, 200);
        assert.equal(response.body.room.current_turn_player_id, benId);
        assert.equal(playerOf(response.body, 'ann'), undefined);
        assert.equal((await entity('RoundScore', annScore.id)).status, 404);
        assert.deepEqual(summarise(published), ['delete RoundScore', 'delete Player', 'update GameRoom']);

        const repeat = await action('ann', roomId, 'leave');
        assert.equal(repeat.status, 404);
        assert.equal(repeat.body.code, 'player_not_found');
    });

    test('the turn wraps to the first player when the last in order leaves', async () => {
        const snapshot = await roomWith('ann', 'ben');
        const roomId = snapshot.room.id;
        await action('host', roomId, 'start');
        await putEntity('GameRoom', roomId, { current_turn_player_id: playerOf(snapshot, 'ben').id });

        const response = await action('ben', roomId, 'leave');
        assert.equal(response.body.room.current_turn_player_id, playerOf(snapshot, 'host').id);
    });

    test('a leaving host passes hosting to the next player by turn order', async () => {
        const snapshot = await roomWith('ann', 'ben');
        const roomId = snapshot.room.id;
        const hostId = playerOf(snapshot, 'host').id;
        await putEntity('GameRoom', roomId, { is_edit_mode: true, edit_mode_by: hostId });

        const response = await action('host', roomId, 'leave');
        assert.equal(response.status, 200);
        assert.equal(response.body.room.host_email, 'ann@example.com');
        assert.equal(response.body.room.host_player_id, playerOf(snapshot, 'ann').id);
        assert.equal(response.body.room.is_edit_mode, false);
        assert.equal(playerOf(response.body, 'ann').is_host, true);
        assert.equal(playerOf(response.body, 'ben').is_host, false);
    });

    test('edit mode ends when the player who turned it on leaves', async () => {
        const snapshot = await roomWith('ann');
        const roomId = snapshot.room.id;
        await putEntity('GameRoom', roomId, { is_edit_mode: true, edit_mode_by: playerOf(snapshot, 'ann').id });

        const response = await action('ann', roomId, 'leave');
        assert.equal(response.body.room.is_edit_mode, false);
        assert.equal(response.body.room.edit_mode_by, null);
        assert.equal(response.body.room.host_email, 'host@example.com');
    });

    test('kick removes another player, moves the turn and can pass hosting', async () => {
        const snapshot = await roomWith('ann', 'ben');
        const roomId = snapshot.room.id;
        const hostId = playerOf(snapshot, 'host').id;
        const annId = playerOf(snapshot, 'ann').id;
        const benId = playerOf(snapshot, 'ben').id;
        await action('host', roomId, 'start');
        await putEntity('GameRoom', roomId, { current_turn_player_id: annId });

        const kicked = await action('host', roomId, 'kick', { player_id: annId });
        assert.equal(kicked.status, 200);
        assert.equal(kicked.body.room.current_turn_player_id, benId);
        assert.deepEqual(kicked.body.players.map((player) => player.id), [hostId, benId]);

        const repeat = await action('host', roomId, 'kick', { player_id: annId });
        assert.equal(repeat.status, 404);
        assert.equal(repeat.body.code, 'player_not_found');

        const self = await action('host', roomId, 'kick', { player_id: hostId });
        assert.equal(self.status, 400);

        // An admin kicking the host passes hosting on.
        const hostKicked = await action('boss', roomId, 'kick', { player_id: hostId });
        assert.equal(hostKicked.body.room.host_email, 'ben@example.com');
        assert.equal(hostKicked.body.room.current_turn_player_id, benId);
        assert.equal(playerOf(hostKicked.body, 'ben').is_host, true);
    });

    test('the last player leaving closes the room', async () => {
        const created = await createRoom();
        const response = await action('host', created.room.id, 'leave');

        assert.equal(response.status, 200);
        assert.equal(response.body.room.status, 'closed');
        assert.deepEqual(response.body.players, []);
    });

    test('a retried leave after the last player left is player_not_found, not wrong_status', async () => {
        const created = await createRoom();
        assert.equal((await action('host', created.room.id, 'leave')).status, 200);

        const retry = await action('host', created.room.id, 'leave');
        assert.equal(retry.status, 404);
        assert.equal(retry.body.code, 'player_not_found');
    });

    test('the winner leaving clears winner_player_id', async () => {
        const snapshot = await roomWith('ann');
        const roomId = snapshot.room.id;
        const annId = playerOf(snapshot, 'ann').id;
        await putEntity('GameRoom', roomId, { status: 'finished', winner_player_id: annId });

        const response = await action('ann', roomId, 'leave');
        assert.equal(response.status, 200);
        assert.equal(response.body.room.winner_player_id, null);
    });

    // --- Robustness ------------------------------------------------------

    test('an unknown access level throws instead of letting the caller in', async () => {
        const created = await createRoom();
        const context = {
            store: server.instance.store,
            hub: server.instance.hub,
            config: { adminEmails: new Set() },
            logger: silentLogger,
        };
        const request = {
            user: { email: 'outsider@example.com' },
            roomId: created.room.id,
            access: 'hosts',
            allowedStatuses: null,
        };

        assert.throws(() => runRoomAction(context, request, () => {}), /Unknown access level: hosts/);
    });

    test('a failing publish still answers 200 for the committed action', async () => {
        const created = await createRoom();
        const hub = server.instance.hub;
        const workingPublishAll = hub.publishAll;
        hub.publishAll = () => {
            throw new Error('publish failed');
        };

        let response;
        try {
            response = await action('ann', created.room.id, 'join', { name: 'ann' });
        } finally {
            hub.publishAll = workingPublishAll;
        }
        assert.equal(response.status, 200);
        assert.equal(response.body.players.length, 2);
    });

    // --- Start -----------------------------------------------------------

    test('start in a room without players is bad_request', async () => {
        const created = await createRoom();
        await api(baseUrl, 'DELETE', `/api/entities/Player/${created.player.id}`, { cookie: cookies.host });

        const response = await action('boss', created.room.id, 'start');
        assert.equal(response.status, 400);
        assert.equal(response.body.code, 'bad_request');
        assert.equal((await entity('GameRoom', created.room.id)).body.status, 'waiting');
    });

    test('start resets players and deletes RoundScores before the room goes playing', async () => {
        const snapshot = await roomWith('ann');
        const roomId = snapshot.room.id;
        const hostId = playerOf(snapshot, 'host').id;
        const annId = playerOf(snapshot, 'ann').id;
        await putEntity('Player', annId, { total_score: 90, has_submitted_round: true });
        await putEntity('GameRoom', roomId, { winner_player_id: annId, finish_reason: 'ended', current_round: 4 });
        const oldScore = await createEntity('RoundScore', { room_id: roomId, player_id: annId, round_number: 1 });

        published = [];
        const response = await action('host', roomId, 'start');
        assert.equal(response.status, 200);

        const { room } = response.body;
        assert.equal(room.status, 'playing');
        assert.equal(room.current_round, 1);
        assert.equal(room.current_turn_player_id, hostId);
        assert.equal(room.winner_player_id, null);
        assert.equal(room.finish_reason, null);

        const ann = playerOf(response.body, 'ann');
        assert.equal(ann.total_score, 0);
        assert.equal(ann.has_submitted_round, false);
        assert.equal((await entity('RoundScore', oldScore.id)).status, 404);

        assert.deepEqual(summarise(published), ['delete RoundScore', 'update Player', 'update GameRoom']);
        for (const event of published) {
            assert.equal(event.options.roomVersion, room.version);
        }
    });

    // --- Close and delete ------------------------------------------------

    test('delete closes the room, publishes that first, then cascades', async () => {
        const snapshot = await roomWith('ann');
        const roomId = snapshot.room.id;
        const annId = playerOf(snapshot, 'ann').id;
        const chat = await createEntity('ChatMessage', { room_id: roomId, sender_id: annId, emoji: 'x' });
        const score = await createEntity('RoundScore', { room_id: roomId, player_id: annId, round_number: 1 });
        const otherRoom = await createRoom();

        published = [];
        const response = await action('host', roomId, 'delete');
        assert.equal(response.status, 200);
        assert.equal(response.body.room.status, 'closed');
        assert.deepEqual(response.body.players, []);

        assert.deepEqual(summarise(published), [
            'update GameRoom',
            'delete ChatMessage',
            'delete RoundScore',
            'delete Player',
            'delete Player',
            'delete GameRoom',
        ]);
        assert.equal(published[0].record.status, 'closed');
        assert.equal(published.at(-1).record.status, 'closed');
        const versions = new Set(published.map((event) => event.options.roomVersion));
        assert.deepEqual([...versions], [snapshot.room.version + 1]);

        for (const [name, id] of [['GameRoom', roomId], ['ChatMessage', chat.id], ['RoundScore', score.id], ['Player', annId]]) {
            assert.equal((await entity(name, id)).status, 404, name);
        }
        assert.equal((await entity('GameRoom', otherRoom.room.id)).status, 200);

        const repeat = await action('host', roomId, 'delete');
        assert.equal(repeat.status, 404);
        assert.equal(repeat.body.code, 'room_not_found');
    });

    test('unknown actions are 404', async () => {
        const created = await createRoom();
        const response = await action('host', created.room.id, 'nonsense');
        assert.equal(response.status, 404);
    });
});
