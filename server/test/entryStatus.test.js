import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { api, connectRealtime, devLogin, startTestServer } from './helpers.js';

// The entering-cards signal over real sockets.
//
// Wire shapes these tests pin down:
//   client -> server  { type: 'entry-status', room_id, state: 'scanning' | 'typing' | null, round }
//   server -> room    { type: 'entry-status', room_id, entries: [{ player_id, state, round }] }
// The server message always carries the room's whole current list, so a late joiner and a
// client that missed a change get the same thing. Time comes from the injected realtime clock.

const SCANNING_TTL_MS = 120_000;
const TYPING_TTL_MS = 45_000;
const SECOND = 1000;
const THROTTLE_MS = 1000;

describe('entry status over realtime', () => {
    let server;
    const clock = { time: 1_000_000 };
    const cookies = {};
    const openClients = [];

    before(async () => {
        server = await startTestServer({ realtimeNow: () => clock.time });
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

    function action(who, roomId, name, body = {}) {
        return api(server.baseUrl, 'POST', `/api/rooms/${roomId}/actions/${name}`, {
            cookie: cookies[who],
            body,
        });
    }

    /** A started room (round 1) with host, ann and ben. Returns { roomId, hostId, annId, benId }. */
    async function playingRoom() {
        const created = await api(server.baseUrl, 'POST', '/api/rooms', {
            cookie: cookies.host,
            body: { max_score: 200 },
        });
        const roomId = created.body.room.id;
        const annJoined = await action('ann', roomId, 'join', { name: 'ann' });
        const benJoined = await action('ben', roomId, 'join', { name: 'ben' });
        const started = await action('host', roomId, 'start');
        assert.equal(started.status, 200);
        return {
            roomId,
            hostId: created.body.player.id,
            annId: annJoined.body.player.id,
            benId: benJoined.body.player.id,
        };
    }

    function score(round = 1) {
        return {
            round_number: round,
            cards: [{ value: '5', type: 'number' }],
            base_sum: 5,
            final_score: 5,
        };
    }

    /**
     * Resolves once the server has handled every message this client sent before. The server
     * handles one socket's messages in order, so a pong proves the earlier ones are done.
     */
    async function settle(client) {
        const from = client.log.messages.length;
        client.send({ type: 'ping' });
        await client.log.waitFor((message) => message.type === 'pong', { from });
    }

    /** Connects and subscribes to `roomId`; resolves once ready, and all that follows it, arrived. */
    async function subscribe(name, roomId) {
        const client = connectRealtime(server.wsUrl, cookies[name]);
        openClients.push(client);
        await client.opened;
        client.send({ type: 'hello', epoch: null, last_seq: null, rooms: [roomId] });
        await client.log.waitFor((message) => message.type === 'ready');
        await settle(client);
        return client;
    }

    function announce(client, roomId, state, round = 1) {
        client.send({ type: 'entry-status', room_id: roomId, state, round });
    }

    /** { player_id: state } for an entry-status message. */
    function summarize(message) {
        const summary = {};
        for (const entry of message.entries) {
            summary[entry.player_id] = entry.state;
        }
        return summary;
    }

    function entryStatusMessages(client, from = 0) {
        return client.log.messages.slice(from).filter((message) => message.type === 'entry-status');
    }

    /** What the client currently believes: the last entry-status list it got, or nobody. */
    function currentEntries(client) {
        const messages = entryStatusMessages(client);
        if (messages.length === 0) {
            return {};
        }
        return summarize(messages[messages.length - 1]);
    }

    /** Waits for an entry-status list equal to `expected`, looking at messages from index `from` on. */
    async function waitForEntries(client, expected, from = 0) {
        const matches = (message) => {
            if (message.type !== 'entry-status') {
                return false;
            }
            return isDeepStrictEqual(summarize(message), expected);
        };

        try {
            return await client.log.waitFor(matches, { from });
        } catch {
            throw new Error(`No entry-status list equal to ${JSON.stringify(expected)} arrived`);
        }
    }

    /** True when every entry-status message since `from` shows exactly `expected`. */
    function onlyEverShowed(client, expected, from) {
        const messages = entryStatusMessages(client, from);
        return messages.every((message) => {
            return isDeepStrictEqual(summarize(message), expected);
        });
    }

    // --- Broadcast -------------------------------------------------------

    test('a member\'s scanning status reaches the room with their player id and round', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        const from = host.log.messages.length;

        announce(ann, roomId, 'scanning');

        const message = await waitForEntries(host, { [annId]: 'scanning' }, from);
        assert.equal(message.room_id, roomId);
        assert.deepEqual(message.entries, [{ player_id: annId, state: 'scanning', round: 1 }]);
    });

    test('a new state replaces the old one, and null clears it', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        const from = host.log.messages.length;

        announce(ann, roomId, 'scanning');
        await waitForEntries(host, { [annId]: 'scanning' }, from);
        clock.time += THROTTLE_MS;
        announce(ann, roomId, 'typing');
        await waitForEntries(host, { [annId]: 'typing' }, from);
        announce(ann, roomId, null);
        await waitForEntries(host, {}, from);

        assert.deepEqual(currentEntries(host), {});
    });

    test('several players can be entering at once', async () => {
        const { roomId, annId, benId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        const ben = await subscribe('ben', roomId);

        announce(ann, roomId, 'typing');
        announce(ben, roomId, 'scanning');

        await waitForEntries(host, { [annId]: 'typing', [benId]: 'scanning' });
    });

    test('a socket in another room does not hear the status', async () => {
        const first = await playingRoom();
        const second = await playingRoom();
        const watcher = await subscribe('host', second.roomId);
        const sameRoomListener = await subscribe('host', first.roomId);
        const ann = await subscribe('ann', first.roomId);
        const from = watcher.log.messages.length;

        announce(ann, first.roomId, 'typing');
        // Proves the status was sent and delivered where it belongs before checking the other room.
        await waitForEntries(sameRoomListener, { [first.annId]: 'typing' });
        await settle(watcher);

        assert.deepEqual(entryStatusMessages(watcher, from), []);
    });

    // --- Membership and validation ---------------------------------------

    test('a socket that is not a member of the room is ignored', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        // Non-members are dropped from the room list, so this socket is not subscribed either.
        const outsider = await subscribe('outsider', roomId);
        const from = host.log.messages.length;

        announce(outsider, roomId, 'typing');
        await settle(outsider);
        announce(ann, roomId, 'typing');

        await waitForEntries(host, { [annId]: 'typing' }, from);
        assert.ok(onlyEverShowed(host, { [annId]: 'typing' }, from));
    });

    test('a member whose socket is not subscribed to the room is ignored', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        const unsubscribed = connectRealtime(server.wsUrl, cookies.ben);
        openClients.push(unsubscribed);
        await unsubscribed.opened;
        unsubscribed.send({ type: 'hello', epoch: null, last_seq: null, rooms: [] });
        await unsubscribed.log.waitFor((message) => message.type === 'ready');
        const from = host.log.messages.length;

        announce(unsubscribed, roomId, 'typing');
        await settle(unsubscribed);
        announce(ann, roomId, 'typing');

        await waitForEntries(host, { [annId]: 'typing' }, from);
        assert.ok(onlyEverShowed(host, { [annId]: 'typing' }, from));
    });

    test('an unknown state or a malformed message is ignored', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        const from = host.log.messages.length;

        announce(ann, roomId, 'dancing');
        announce(ann, roomId, undefined);
        ann.send({ type: 'entry-status', state: 'typing', round: 1 });
        ann.send({ type: 'entry-status', room_id: roomId, state: 'typing', round: 'one' });
        ann.send({ type: 'entry-status', room_id: roomId, state: 'typing' });
        await settle(ann);
        announce(ann, roomId, 'typing');

        await waitForEntries(host, { [annId]: 'typing' }, from);
        assert.ok(onlyEverShowed(host, { [annId]: 'typing' }, from));
    });

    test('a status for a round other than the room\'s current round is ignored', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        const from = host.log.messages.length;

        announce(ann, roomId, 'typing', 5);
        await settle(ann);
        // A wrong round still costs a database lookup, so it counts against the throttle.
        clock.time += THROTTLE_MS;
        announce(ann, roomId, 'typing', 1);

        await waitForEntries(host, { [annId]: 'typing' }, from);
        assert.ok(onlyEverShowed(host, { [annId]: 'typing' }, from));
    });

    // --- Throttling -------------------------------------------------------

    test('alternating states within a second reaches the room once', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        const from = host.log.messages.length;

        for (let index = 0; index < 10; index += 1) {
            announce(ann, roomId, index % 2 === 0 ? 'scanning' : 'typing');
        }
        await settle(ann);
        await settle(host);

        const messages = entryStatusMessages(host, from);
        assert.equal(messages.length, 1);
        assert.deepEqual(summarize(messages[0]), { [annId]: 'scanning' });
    });

    test('alternating states does not touch the database per message', async () => {
        const { roomId } = await playingRoom();
        const ann = await subscribe('ann', roomId);
        const { store } = server.instance;
        const originalFind = store.findRecords;
        let lookups = 0;
        store.findRecords = (...args) => {
            lookups += 1;
            return originalFind.apply(store, args);
        };

        try {
            for (let index = 0; index < 10; index += 1) {
                announce(ann, roomId, index % 2 === 0 ? 'scanning' : 'typing');
            }
            await settle(ann);
        } finally {
            store.findRecords = originalFind;
        }

        // One message's worth: the rest are dropped before any lookup.
        assert.ok(lookups <= 2, `expected at most 2 lookups, saw ${lookups}`);
    });

    test('repeated clears with nothing to clear do not touch the database', async () => {
        const { roomId } = await playingRoom();
        const ann = await subscribe('ann', roomId);
        const { store } = server.instance;
        const originalFind = store.findRecords;
        let lookups = 0;
        store.findRecords = (...args) => {
            lookups += 1;
            return originalFind.apply(store, args);
        };

        try {
            for (let index = 0; index < 10; index += 1) {
                announce(ann, roomId, null);
            }
            await settle(ann);
        } finally {
            store.findRecords = originalFind;
        }

        assert.equal(lookups, 0);
    });

    test('the state changes again once the second is up', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        const from = host.log.messages.length;
        announce(ann, roomId, 'scanning');
        await waitForEntries(host, { [annId]: 'scanning' }, from);

        clock.time += THROTTLE_MS;
        announce(ann, roomId, 'typing');

        await waitForEntries(host, { [annId]: 'typing' }, from);
    });

    // The window really is 1 s here: the held state is applied by a timer, not by the injected clock.

    test('a burst that ends on a new state shows it when the window ends, with no help from a heartbeat', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        const from = host.log.messages.length;

        // Scan, Back, Manual within a second.
        announce(ann, roomId, 'scanning');
        await waitForEntries(host, { [annId]: 'scanning' }, from);
        announce(ann, roomId, null);
        await waitForEntries(host, {}, from);
        announce(ann, roomId, 'typing');

        await waitForEntries(host, { [annId]: 'typing' }, from);
    });

    test('a held state is only the latest one, however many came in', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        const from = host.log.messages.length;

        for (let index = 0; index < 11; index += 1) {
            announce(ann, roomId, index % 2 === 0 ? 'scanning' : 'typing');
        }
        announce(ann, roomId, 'typing');
        await waitForEntries(host, { [annId]: 'typing' }, from);

        const messages = entryStatusMessages(host, from);
        assert.deepEqual(messages.map(summarize), [{ [annId]: 'scanning' }, { [annId]: 'typing' }]);
    });

    test('a burst that ends back on the shown state holds nothing', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        const from = host.log.messages.length;

        announce(ann, roomId, 'scanning');
        announce(ann, roomId, 'typing');
        announce(ann, roomId, 'scanning');
        await waitForEntries(host, { [annId]: 'scanning' }, from);
        await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS + 100));
        await settle(host);

        assert.equal(entryStatusMessages(host, from).length, 1);
    });

    test('a clear cancels a held state, so closing entry can\'t bring it back', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        const from = host.log.messages.length;

        announce(ann, roomId, 'scanning');
        announce(ann, roomId, 'typing');
        announce(ann, roomId, null);
        await waitForEntries(host, {}, from);
        await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS + 100));
        await settle(host);

        assert.deepEqual(currentEntries(host), {});
        assert.ok(entryStatusMessages(host, from).every((message) => !summarize(message)[annId] || summarize(message)[annId] === 'scanning'));
    });

    test('a state held across my submit doesn\'t bring me back', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        announce(ann, roomId, 'scanning');
        await waitForEntries(host, { [annId]: 'scanning' });
        announce(ann, roomId, 'typing');
        await settle(ann);

        const submitted = await action('ann', roomId, 'submit-score', score());
        assert.equal(submitted.status, 200);
        await waitForEntries(host, {});
        await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS + 100));
        await settle(host);

        assert.deepEqual(currentEntries(host), {});
    });

    test('a state held while the socket drops is forgotten, and the client says it again on ready', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        const from = host.log.messages.length;
        announce(ann, roomId, 'scanning');
        await waitForEntries(host, { [annId]: 'scanning' }, from);
        announce(ann, roomId, 'typing');
        await settle(ann);

        ann.send({ type: 'rooms', rooms: [] });
        await settle(ann);
        await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS + 100));
        await settle(host);

        assert.deepEqual(currentEntries(host), { [annId]: 'scanning' });
    });

    test('a clear is never delayed, even right after an announce', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        const from = host.log.messages.length;
        announce(ann, roomId, 'typing');
        await waitForEntries(host, { [annId]: 'typing' }, from);

        announce(ann, roomId, null);

        await waitForEntries(host, {}, from);
    });

    test('one player\'s throttle does not hold up another player', async () => {
        const { roomId, annId, benId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        const ben = await subscribe('ben', roomId);

        announce(ann, roomId, 'typing');
        announce(ben, roomId, 'typing');

        await waitForEntries(host, { [annId]: 'typing', [benId]: 'typing' });
    });

    test('a throttled heartbeat changes nothing about the time to live', async () => {
        const { roomId, annId } = await playingRoom();
        const ann = await subscribe('ann', roomId);
        announce(ann, roomId, 'typing');
        await settle(ann);

        clock.time += THROTTLE_MS / 2;
        announce(ann, roomId, 'typing');
        await settle(ann);

        clock.time += TYPING_TTL_MS - THROTTLE_MS;
        assert.deepEqual(currentEntries(await subscribe('ben', roomId)), { [annId]: 'typing' });
        clock.time += THROTTLE_MS;
        assert.deepEqual(currentEntries(await subscribe('ben', roomId)), {});
    });

    test('an old throttle is forgotten by the periodic sweep, and a status is still accepted after it', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        announce(ann, roomId, 'scanning');
        await waitForEntries(host, { [annId]: 'scanning' });
        const from = host.log.messages.length;

        clock.time += SCANNING_TTL_MS + SECOND;
        server.instance.hub.checkLiveness();
        await waitForEntries(host, {}, from);

        announce(ann, roomId, 'typing');
        await waitForEntries(host, { [annId]: 'typing' }, from);
    });

    // --- Late joiners ----------------------------------------------------

    test('a socket that connects later gets the current state after ready', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        announce(ann, roomId, 'scanning');
        await waitForEntries(host, { [annId]: 'scanning' });

        const lateJoiner = await subscribe('ben', roomId);

        assert.deepEqual(currentEntries(lateJoiner), { [annId]: 'scanning' });
        const readyIndex = lateJoiner.log.messages.findIndex((message) => message.type === 'ready');
        const entryIndex = lateJoiner.log.messages.findIndex((message) => message.type === 'entry-status');
        assert.ok(entryIndex > readyIndex, 'the state follows ready');
    });

    test('a socket that adds the room later through a rooms message gets the state too', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        announce(ann, roomId, 'typing');
        await waitForEntries(host, { [annId]: 'typing' });

        const ben = connectRealtime(server.wsUrl, cookies.ben);
        openClients.push(ben);
        await ben.opened;
        ben.send({ type: 'hello', epoch: null, last_seq: null, rooms: [] });
        await ben.log.waitFor((message) => message.type === 'ready');
        ben.send({ type: 'rooms', rooms: [roomId] });
        await ben.log.waitFor((message) => message.type === 'rooms-ok');
        await settle(ben);

        assert.deepEqual(currentEntries(ben), { [annId]: 'typing' });
    });

    // --- Surviving the camera (X26) --------------------------------------

    test('a status survives its socket closing, because the camera kills the socket', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        announce(ann, roomId, 'scanning');
        await waitForEntries(host, { [annId]: 'scanning' });
        const from = host.log.messages.length;

        await ann.close();
        await host.log.waitFor((message) => {
            if (message.type !== 'presence') {
                return false;
            }
            const annPresence = message.players.find((player) => player.player_id === annId);
            return annPresence.online === false;
        }, { from });
        await settle(host);

        assert.ok(onlyEverShowed(host, { [annId]: 'scanning' }, from));
        const lateJoiner = await subscribe('ben', roomId);
        assert.deepEqual(currentEntries(lateJoiner), { [annId]: 'scanning' });
    });

    // --- Time to live ----------------------------------------------------

    test('a scanning status lasts 120 seconds', async () => {
        const { roomId, annId } = await playingRoom();
        const ann = await subscribe('ann', roomId);
        announce(ann, roomId, 'scanning');
        await settle(ann);

        clock.time += SCANNING_TTL_MS - 1 * SECOND;
        assert.deepEqual(currentEntries(await subscribe('ben', roomId)), { [annId]: 'scanning' });

        clock.time += 2 * SECOND;
        assert.deepEqual(currentEntries(await subscribe('ben', roomId)), {});
    });

    test('a typing status lasts 45 seconds, and scanning outlasts it', async () => {
        const { roomId, annId, benId } = await playingRoom();
        const ann = await subscribe('ann', roomId);
        const ben = await subscribe('ben', roomId);
        announce(ann, roomId, 'typing');
        announce(ben, roomId, 'scanning');
        await settle(ann);
        await settle(ben);

        clock.time += TYPING_TTL_MS - 1 * SECOND;
        const justBefore = await subscribe('host', roomId);
        assert.deepEqual(currentEntries(justBefore), { [annId]: 'typing', [benId]: 'scanning' });

        clock.time += 2 * SECOND;
        const justAfter = await subscribe('host', roomId);
        assert.deepEqual(currentEntries(justAfter), { [benId]: 'scanning' });
    });

    test('repeating a typing status (the 15 s heartbeat) restarts its time to live', async () => {
        const { roomId, annId } = await playingRoom();
        const ann = await subscribe('ann', roomId);
        announce(ann, roomId, 'typing');
        await settle(ann);

        clock.time += 30 * SECOND;
        announce(ann, roomId, 'typing');
        await settle(ann);

        // 60 s after the first message, but only 30 s after the last.
        clock.time += 30 * SECOND;
        assert.deepEqual(currentEntries(await subscribe('ben', roomId)), { [annId]: 'typing' });

        // 50 s after the last one, with no heartbeat in between.
        clock.time += 20 * SECOND;
        assert.deepEqual(currentEntries(await subscribe('ben', roomId)), {});
    });

    test('a status that expires is cleared for the sockets already in the room', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        announce(ann, roomId, 'typing');
        await waitForEntries(host, { [annId]: 'typing' });
        const from = host.log.messages.length;

        clock.time += TYPING_TTL_MS + 1 * SECOND;
        // The periodic liveness check is the hub's timer tick, so it sweeps expired statuses too.
        server.instance.hub.checkLiveness();

        await waitForEntries(host, {}, from);
    });

    // --- Cleared by -------------------------------------------------------

    test('the player submitting a score clears their status, with no socket message needed', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        announce(ann, roomId, 'typing');
        await waitForEntries(host, { [annId]: 'typing' });
        const from = host.log.messages.length;

        const submitted = await action('ann', roomId, 'submit-score', score());
        assert.equal(submitted.status, 200);

        await waitForEntries(host, {}, from);
    });

    test('someone else submitting does not clear a player\'s status', async () => {
        const { roomId, annId } = await playingRoom();
        const ann = await subscribe('ann', roomId);
        announce(ann, roomId, 'typing');
        await settle(ann);

        const submitted = await action('ben', roomId, 'submit-score', score());
        assert.equal(submitted.status, 200);

        assert.deepEqual(currentEntries(await subscribe('host', roomId)), { [annId]: 'typing' });
    });

    test('a player who leaves has their status cleared', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        announce(ann, roomId, 'scanning');
        await waitForEntries(host, { [annId]: 'scanning' });
        const from = host.log.messages.length;

        const left = await action('ann', roomId, 'leave');
        assert.equal(left.status, 200);

        await waitForEntries(host, {}, from);
    });

    test('a player who is kicked has their status cleared', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        announce(ann, roomId, 'scanning');
        await waitForEntries(host, { [annId]: 'scanning' });
        const from = host.log.messages.length;

        const kicked = await action('host', roomId, 'kick', { player_id: annId });
        assert.equal(kicked.status, 200);

        await waitForEntries(host, {}, from);
    });

    test('a status for a round that has ended is cleared when the round moves on', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        announce(ann, roomId, 'typing');
        await waitForEntries(host, { [annId]: 'typing' });
        const from = host.log.messages.length;

        const forced = await action('host', roomId, 'force-next-round', { round_number: 1 });
        assert.equal(forced.status, 200);
        assert.equal(forced.body.room.current_round, 2);

        await waitForEntries(host, {}, from);
        assert.deepEqual(currentEntries(await subscribe('ben', roomId)), {});
    });

    test('a status is cleared when the game ends', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        announce(ann, roomId, 'typing');
        await waitForEntries(host, { [annId]: 'typing' });
        const from = host.log.messages.length;

        const ended = await action('host', roomId, 'end-game');
        assert.equal(ended.status, 200);

        await waitForEntries(host, {}, from);
    });

    test('a heartbeat that crosses my submit does not bring my status back', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        announce(ann, roomId, 'typing');
        await waitForEntries(host, { [annId]: 'typing' });
        const submitted = await action('ann', roomId, 'submit-score', score());
        assert.equal(submitted.status, 200);
        await waitForEntries(host, {});

        announce(ann, roomId, 'typing');
        await settle(ann);

        assert.deepEqual(currentEntries(await subscribe('ben', roomId)), {});
    });

    test('null from a player with no status tells nobody anything', async () => {
        const { roomId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        const from = host.log.messages.length;

        announce(ann, roomId, null);
        await settle(ann);
        await settle(host);

        assert.deepEqual(entryStatusMessages(host, from), []);
    });

    test('null clears my status even when it names a round that has ended', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        announce(ann, roomId, 'typing');
        await waitForEntries(host, { [annId]: 'typing' });
        const from = host.log.messages.length;

        announce(ann, roomId, null, 99);

        await waitForEntries(host, {}, from);
    });

    test('a heartbeat renews the time without telling the room again', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        announce(ann, roomId, 'typing');
        await waitForEntries(host, { [annId]: 'typing' });
        const from = host.log.messages.length;

        announce(ann, roomId, 'typing');
        await settle(ann);
        await settle(host);

        assert.deepEqual(entryStatusMessages(host, from), []);
    });

    test('a status leaves the room version and the event log alone', async () => {
        const { roomId, annId } = await playingRoom();
        const host = await subscribe('host', roomId);
        const ann = await subscribe('ann', roomId);
        const versionBefore = server.instance.store.getRecord('GameRoom', roomId).version;
        const seqBefore = server.instance.hub.seq;

        announce(ann, roomId, 'typing');
        await waitForEntries(host, { [annId]: 'typing' });

        assert.equal(server.instance.hub.seq, seqBefore);
        assert.equal(server.instance.store.getRecord('GameRoom', roomId).version, versionBefore);
    });
});
