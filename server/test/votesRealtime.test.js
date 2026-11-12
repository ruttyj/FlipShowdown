import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, connectRealtime, devLogin, startTestServer } from './helpers.js';

// Hold-to-vote over real sockets, with a short hold time.

const VOTE_HOLD_MS = 150;
const TOPIC = 'make-host';

describe('hold-to-vote over realtime', () => {
    let server;
    const cookies = {};
    const openClients = [];

    before(async () => {
        server = await startTestServer({ voteHoldMs: VOTE_HOLD_MS });
        for (const name of ['host', 'ann', 'ben', 'outsider']) {
            cookies[name] = await devLogin(server.baseUrl, `${name}@example.com`, name);
        }
    });

    after(async () => {
        for (const client of openClients) {
            await client.close();
        }
        await server.stop();
    });

    // --- Helpers ---------------------------------------------------------

    /** A room created by host, with ann joined. Returns { roomId, hostId, annId }. */
    async function roomWithAnn() {
        const created = await api(server.baseUrl, 'POST', '/api/rooms', {
            cookie: cookies.host,
            body: { max_score: 200 },
        });
        const roomId = created.body.room.id;
        const joined = await api(server.baseUrl, 'POST', `/api/rooms/${roomId}/actions/join`, {
            cookie: cookies.ann,
            body: { name: 'ann' },
        });
        assert.equal(joined.status, 200);
        return { roomId, hostId: created.body.player.id, annId: joined.body.player.id };
    }

    /** Connects and subscribes to `roomId`; resolves once ready has arrived. */
    async function subscribe(name, roomId) {
        const client = connectRealtime(server.wsUrl, cookies[name]);
        openClients.push(client);
        await client.opened;
        client.send({ type: 'hello', epoch: null, last_seq: null, rooms: [roomId] });
        await client.nextOfType('ready');
        return client;
    }

    /** Skips messages until one matches `predicate`. */
    async function nextMatching(client, predicate) {
        let message = await client.next();
        while (!predicate(message)) {
            message = await client.next();
        }
        return message;
    }

    function nextVote(client, predicate) {
        return nextMatching(client, (message) => message.type === 'vote' && predicate(message));
    }

    function hold(client, roomId, option) {
        client.send({ type: 'vote-hold', room_id: roomId, topic: TOPIC, option });
    }

    // --- Tests -----------------------------------------------------------

    test('ready is followed by presence, then the room\'s vote state', async () => {
        const { roomId } = await roomWithAnn();
        const client = connectRealtime(server.wsUrl, cookies.host);
        openClients.push(client);
        await client.opened;
        client.send({ type: 'hello', epoch: null, last_seq: null, rooms: [roomId] });

        assert.equal((await client.next()).type, 'ready');
        assert.equal((await client.next()).type, 'presence');
        const vote = await client.next();
        assert.equal(vote.type, 'vote');
        assert.equal(vote.room_id, roomId);
        assert.equal(vote.topic, TOPIC);
        assert.deepEqual(vote.holds, []);
        assert.equal(vote.pending, null);
        await client.close();
    });

    test('a full make-host vote moves the host and broadcasts vote-passed after the events', async () => {
        const { roomId, hostId, annId } = await roomWithAnn();
        const hostClient = await subscribe('host', roomId);
        const annClient = await subscribe('ann', roomId);
        await nextVote(hostClient, (vote) => vote.eligible.length === 2);

        hold(annClient, roomId, annId);
        await nextVote(hostClient, (vote) => vote.holds.length === 1);
        hold(hostClient, roomId, annId);

        const pending = await nextVote(hostClient, (vote) => vote.pending !== null);
        assert.deepEqual([...pending.eligible].sort(), [hostId, annId].sort());
        assert.equal(pending.pending.option, annId);
        assert.ok(pending.pending.remaining_ms <= VOTE_HOLD_MS);

        for (const client of [hostClient, annClient]) {
            // The action's events come first, the room's last; vote-passed follows them.
            const roomEvent = await nextMatching(client, (message) => message.entity === 'GameRoom');
            assert.equal(roomEvent.event.data.host_email, 'ann@example.com');
            const passed = await nextMatching(client, (message) => {
                return message.type !== 'vote' && message.type !== 'presence';
            });
            assert.deepEqual(passed, { type: 'vote-passed', room_id: roomId, topic: TOPIC, option: annId });
        }

        const room = server.instance.store.getRecord('GameRoom', roomId);
        assert.equal(room.host_email, 'ann@example.com');
        assert.equal(room.host_player_id, annId);
    });

    test('a host change through the HTTP make-host action re-evaluates the votes', async () => {
        const { roomId, annId } = await roomWithAnn();
        const joined = await api(server.baseUrl, 'POST', `/api/rooms/${roomId}/actions/join`, {
            cookie: cookies.ben,
            body: { name: 'ben' },
        });
        const benId = joined.body.player.id;

        // Ann alone holding Ben doesn't pass while the online host hasn't held.
        const hostClient = await subscribe('host', roomId);
        const annClient = await subscribe('ann', roomId);
        await nextVote(hostClient, (vote) => vote.eligible.length === 2);
        hold(annClient, roomId, benId);
        const held = await nextVote(hostClient, (vote) => vote.holds.length === 1);
        assert.equal(held.pending, null);

        // Ann becomes host, so her hold alone now decides.
        const madeHost = await api(server.baseUrl, 'POST', `/api/rooms/${roomId}/actions/make-host`, {
            cookie: cookies.host,
            body: { player_id: annId },
        });
        assert.equal(madeHost.status, 200);
        const pending = await nextVote(hostClient, (vote) => vote.pending !== null);
        assert.equal(pending.pending.option, benId);
        await nextMatching(hostClient, (message) => message.type === 'vote-passed');
        assert.equal(server.instance.store.getRecord('GameRoom', roomId).host_player_id, benId);
    });

    test('the host holding a player alone makes them host after the hold time', async () => {
        const { roomId, annId } = await roomWithAnn();
        const hostClient = await subscribe('host', roomId);
        await subscribe('ann', roomId);
        await nextVote(hostClient, (vote) => vote.eligible.length === 2);

        hold(hostClient, roomId, annId);
        const pending = await nextVote(hostClient, (vote) => vote.pending !== null);
        assert.equal(pending.pending.option, annId);
        await nextMatching(hostClient, (message) => message.type === 'vote-passed');
        assert.equal(server.instance.store.getRecord('GameRoom', roomId).host_player_id, annId);
    });

    test('a non-member\'s vote-hold is rejected with vote-error', async () => {
        const { roomId, annId } = await roomWithAnn();
        const outsider = await subscribe('outsider', roomId);

        hold(outsider, roomId, annId);
        assert.deepEqual(await outsider.next(), {
            type: 'vote-error',
            room_id: roomId,
            topic: TOPIC,
            code: 'not_member',
        });
    });

    test('invalid options and unknown topics are rejected', async () => {
        const { roomId, hostId } = await roomWithAnn();
        const hostClient = await subscribe('host', roomId);

        hold(hostClient, roomId, hostId);
        assert.equal((await hostClient.nextOfType('vote-error')).code, 'invalid_option');
        hold(hostClient, roomId, 'no-such-player');
        assert.equal((await hostClient.nextOfType('vote-error')).code, 'invalid_option');
        hostClient.send({ type: 'vote-hold', room_id: roomId, topic: 'nope', option: hostId });
        assert.equal((await hostClient.nextOfType('vote-error')).code, 'unknown_topic');
        hostClient.send({ type: 'vote-release', topic: TOPIC });
        assert.equal((await hostClient.nextOfType('vote-error')).code, 'bad_request');
    });

    test('closing the holding socket drops its hold', async () => {
        const { roomId, annId } = await roomWithAnn();
        const hostClient = await subscribe('host', roomId);
        const annHolding = await subscribe('ann', roomId);
        // A second socket keeps ann online, so only the hold changes.
        await subscribe('ann', roomId);

        hold(annHolding, roomId, annId);
        await nextVote(hostClient, (vote) => vote.holds.length === 1);

        await annHolding.close();
        const dropped = await nextVote(hostClient, () => true);
        assert.deepEqual(dropped.holds, []);
        assert.equal(dropped.eligible.length, 2);
    });
});
