// The client's real RealtimeConnection and room channel against the real hub, over a real socket:
// what a phone actually does, minus the browser. A wire change on one side alone fails here.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { RealtimeConnection } from '../../src/api/realtime.js';
import { createRoomChannel } from '../../src/api/roomChannel.js';
import { api, devLogin, startTestServer } from './helpers.js';

const TOPIC = 'make-host';
const VOTE_HOLD_MS = 50;
const WAIT_TIMEOUT_MS = 4000;
const WAIT_STEP_MS = 5;

// --- Helpers ---------------------------------------------------------------------

async function waitUntil(isDone, description) {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (!isDone()) {
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting until ${description}`);
        }
        await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
    }
}

/**
 * One phone: a connection and its channel. `target` says where it connects, so a test can move it
 * to a restarted server, and `dropSocket()` loses the connection the way a network change would.
 */
function connectPhone(target, cookie) {
    const sockets = [];

    class PhoneSocket extends WebSocket {
        constructor() {
            super(target.wsUrl, { headers: { cookie } });
            sockets.push(this);
        }
    }

    const connection = new RealtimeConnection({ url: target.wsUrl, WebSocketImpl: PhoneSocket });
    const channel = createRoomChannel(connection);

    return {
        connection,
        channel,
        dropSocket: () => sockets.at(-1).terminate(),
        socketCount: () => sockets.length,
    };
}

/** Joins a phone to the room, recording what the channel hands over. */
function joinRoom(phone, roomId) {
    phone.changes = [];
    phone.staleCount = 0;
    phone.presence = [];
    phone.leave = phone.channel.joinRoom(roomId, {
        onRecordChange: (entity, event, meta) => phone.changes.push({ entity, event, meta }),
        onPresence: (players) => {
            phone.presence = players;
        },
        onStale: () => {
            phone.staleCount += 1;
        },
    });
}

function hangUp(phone) {
    phone.leave();
    // Skips the idle delay, so no timer outlives the test.
    phone.connection.closeIdle();
}

function holdersOf(phone, roomId) {
    const holds = phone.channel.getVote(roomId, TOPIC)?.holds ?? [];
    return holds.map((hold) => hold.playerId);
}

/** Remembers an open ballot or entry, so it is closed however the test ends. */
function remember(context, handle) {
    context.opened.push(handle);
    return handle;
}

async function action(context, roomId, name, cookie, body = {}) {
    const response = await api(context.server.baseUrl, 'POST', `/api/rooms/${roomId}/actions/${name}`, { cookie, body });
    assert.equal(response.status, 200, `${name}: ${JSON.stringify(response.body)}`);
    return response.body;
}

// --- Fixture ------------------------------------------------------------------------

/** A room with a host and a guest, both online and joined to it. */
async function setUpRoom(context) {
    context.server = await startTestServer({ voteHoldMs: VOTE_HOLD_MS });
    context.target = { wsUrl: context.server.wsUrl };
    context.hostCookie = await devLogin(context.server.baseUrl, 'host@example.com', 'Host');
    context.guestCookie = await devLogin(context.server.baseUrl, 'guest@example.com', 'Guest');

    const created = await api(context.server.baseUrl, 'POST', '/api/rooms', {
        cookie: context.hostCookie,
        body: { max_score: 200 },
    });
    context.roomId = created.body.room.id;
    context.hostId = created.body.player.id;
    const joined = await action(context, context.roomId, 'join', context.guestCookie, { name: 'Guest' });
    context.guestId = joined.player.id;

    context.host = connectPhone(context.target, context.hostCookie);
    context.guest = connectPhone(context.target, context.guestCookie);
    joinRoom(context.host, context.roomId);
    joinRoom(context.guest, context.roomId);
    await waitUntil(() => context.host.staleCount > 0 && context.guest.staleCount > 0, 'both phones are ready');
}

describe('the client channel against the real hub', () => {
    const context = {};

    beforeEach(async () => {
        context.opened = [];
        await setUpRoom(context);
    });

    afterEach(async () => {
        // Also after a failed test: an open entry's heartbeat would keep the run from ever ending.
        for (const handle of context.opened) {
            handle.close();
        }
        hangUp(context.host);
        hangUp(context.guest);
        await context.server.stop();
    });

    // --- Round trips ---------------------------------------------------------------

    test('a game action reaches a joined phone as a record change with its room version', async () => {
        const { room } = await action(context, context.roomId, 'start', context.hostCookie);

        await waitUntil(
            () => context.guest.changes.some(({ entity }) => entity === 'GameRoom'),
            'the guest hears about the room',
        );
        const change = context.guest.changes.find(({ entity }) => entity === 'GameRoom');
        assert.equal(change.event.data.status, 'playing');
        assert.equal(change.meta.roomVersion, room.version);
    });

    test('presence reaches a phone in the channel\'s terms', async () => {
        await waitUntil(() => context.host.presence.length === 2, 'the host has presence for both players');

        const guest = context.host.presence.find((player) => player.playerId === context.guestId);
        assert.equal(guest.online, true);
    });

    test('a hold goes up to the server and comes back to every phone', async () => {
        const ballot = remember(context, context.guest.channel.openBallot(context.roomId, TOPIC));

        ballot.hold(context.guestId);
        await waitUntil(() => holdersOf(context.host, context.roomId).includes(context.guestId), 'the host sees the hold');
        assert.deepEqual(context.host.channel.getVote(context.roomId, TOPIC).holds, [
            { playerId: context.guestId, option: context.guestId },
        ]);

        ballot.close();
        await waitUntil(() => holdersOf(context.host, context.roomId).length === 0, 'the host sees the release');
    });

    test('a vote that passes reaches the ballot, and one the server refuses says why', async () => {
        const passed = [];
        const errors = [];
        const ballot = remember(context, context.host.channel.openBallot(context.roomId, TOPIC, {
            onPassed: (option) => passed.push(option),
            onError: (code) => errors.push(code),
        }));

        ballot.hold('nobody');
        await waitUntil(() => errors.length > 0, 'the server refuses the option');
        assert.deepEqual(errors, ['invalid_option']);

        ballot.hold(context.guestId);
        await waitUntil(() => passed.length > 0, 'the vote passes');
        assert.deepEqual(passed, [context.guestId]);
    });

    test('an entry goes up to the server and comes back as who is entering, until it closes', async () => {
        await action(context, context.roomId, 'start', context.hostCookie);
        let entering = [];
        const stopWatching = context.host.channel.watchEntering(context.roomId, (entries) => {
            entering = entries;
        });

        const entry = remember(context, context.guest.channel.startEntry(context.roomId, 1));
        entry.announce('typing');
        await waitUntil(() => entering.length === 1, 'the host sees the guest entering');
        assert.deepEqual(entering, [{ playerId: context.guestId, state: 'typing', round: 1 }]);

        entry.close();
        await waitUntil(() => entering.length === 0, 'the host sees the guest stop');
        stopWatching();
    });

    // --- Recovery ------------------------------------------------------------------

    test('after a lost socket a joined room gets what it missed and is told it is stale', async () => {
        const staleBefore = context.guest.staleCount;

        context.guest.dropSocket();
        await action(context, context.roomId, 'start', context.hostCookie);

        await waitUntil(
            () => context.guest.changes.some(({ entity }) => entity === 'GameRoom'),
            'the guest gets the missed event',
        );
        await waitUntil(() => context.guest.staleCount > staleBefore, 'the guest is told to refetch');
        assert.equal(context.guest.socketCount(), 2);
        assert.equal(context.guest.connection.getStatus(), 'live');
    });

    test('after a lost socket a hold that is still pressed is sent again', async () => {
        const ballot = remember(context, context.guest.channel.openBallot(context.roomId, TOPIC));
        ballot.hold(context.guestId);
        await waitUntil(() => holdersOf(context.host, context.roomId).includes(context.guestId), 'the host sees the hold');

        // The server drops a hold with its socket, so the host sees it go and then come back.
        let sawItGo = false;
        const off = context.host.channel.subscribeVotes(() => {
            if (holdersOf(context.host, context.roomId).length === 0) {
                sawItGo = true;
            }
        });
        context.guest.dropSocket();

        await waitUntil(() => sawItGo, 'the server forgets the hold');
        await waitUntil(() => holdersOf(context.host, context.roomId).includes(context.guestId), 'the hold comes back');
        off();
    });

    test('after a server restart an open entry and a watched list both recover', async () => {
        await action(context, context.roomId, 'start', context.hostCookie);
        let entering = [];
        const stopWatching = context.host.channel.watchEntering(context.roomId, (entries) => {
            entering = entries;
        });
        const entry = remember(context, context.guest.channel.startEntry(context.roomId, 1));
        entry.announce('scanning');
        await waitUntil(() => entering.length === 1, 'the host sees the guest scanning');

        const { dataDir } = context.server;
        const hostStale = context.host.staleCount;
        await context.server.instance.close();
        // Entry status is only in memory: the watcher shows nobody once its own connection drops.
        await waitUntil(() => context.host.connection.getStatus() !== 'live', 'the host notices');
        assert.deepEqual(entering, []);

        context.server = await startTestServer({ voteHoldMs: VOTE_HOLD_MS, dataDir });
        context.target.wsUrl = context.server.wsUrl;

        await waitUntil(() => entering.length === 1, 'the guest announces itself to the new server');
        assert.deepEqual(entering, [{ playerId: context.guestId, state: 'scanning', round: 1 }]);
        assert.ok(context.host.staleCount > hostStale);
        stopWatching();
    });
});
