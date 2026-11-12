import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { api, startTestServer, TestPlayer } from './helpers.js';

// End-to-end games: several simulated players talk REST and realtime the way
// the client does (hello with rooms, ready, app-level pings), and the tests
// check what every socket saw against the server's final state.

const VOTE_HOLD_MS = 200;
const LIVE_WINDOW_MS = 15_000;
// Real time: the unlock timer runs on the real clock, unlike presence.
const HOST_OFFLINE_GRACE_MS = 300;

// --- Local event model ---------------------------------------------------

/** The room a realtime message is about, or null for messages without one. */
function messageRoomId(message) {
    if (message.type === 'event') {
        if (message.entity === 'GameRoom') {
            return message.event.id;
        }
        return message.event.data.room_id;
    }
    return message.room_id ?? null;
}

function eventsOf(client) {
    return client.log.messages.filter((message) => message.type === 'event');
}

/**
 * Player.last_seen is written without an entity event; presence carries it,
 * so the model takes it from there.
 */
function applyPresence(model, presence) {
    for (const entry of presence.players) {
        const player = model.Player.get(entry.player_id);
        // null only means "never seen offline", which the record leaves unset.
        if (player && entry.last_seen !== null) {
            model.Player.set(entry.player_id, { ...player, last_seen: entry.last_seen });
        }
    }
}

/** Builds { entity: Map(id -> record) } by applying a socket's events (and presence) in order. */
function buildModel(client) {
    const model = { GameRoom: new Map(), Player: new Map(), RoundScore: new Map(), ChatMessage: new Map() };
    for (const message of client.log.messages) {
        if (message.type === 'presence') {
            applyPresence(model, message);
            continue;
        }
        if (message.type !== 'event') {
            continue;
        }
        const records = model[message.entity];
        if (message.event.type === 'delete') {
            records.delete(message.event.id);
        } else {
            records.set(message.event.id, message.event.data);
        }
    }
    return model;
}

function sortedById(records) {
    return [...records].sort((left, right) => left.id.localeCompare(right.id));
}

function modelRoomState(model, roomId) {
    const inRoom = (record) => record.room_id === roomId;
    return {
        room: model.GameRoom.get(roomId) ?? null,
        players: sortedById([...model.Player.values()].filter(inRoom)),
        roundScores: sortedById([...model.RoundScore.values()].filter(inRoom)),
    };
}

/** The same shape as modelRoomState, read over REST. */
async function fetchRoomState(player, roomId) {
    const query = encodeURIComponent(JSON.stringify({ room_id: roomId }));
    const options = { cookie: player.cookie };
    const baseUrl = player.server.baseUrl;
    const room = await api(baseUrl, 'GET', `/api/entities/GameRoom/${roomId}`, options);
    const players = await api(baseUrl, 'GET', `/api/entities/Player?q=${query}`, options);
    const roundScores = await api(baseUrl, 'GET', `/api/entities/RoundScore?q=${query}`, options);
    return {
        room: room.body,
        players: sortedById(players.body),
        roundScores: sortedById(roundScores.body),
    };
}

/** Replay and live events must join up without gaps in order or duplicates. */
function assertSeqsIncrease(client) {
    let previous = 0;
    for (const message of eventsOf(client)) {
        assert.ok(message.seq > previous, `seq ${message.seq} after ${previous}`);
        previous = message.seq;
    }
}

/** The GameRoom records a socket received, in order. */
function roomHistory(client, roomId) {
    const history = [];
    for (const message of eventsOf(client)) {
        if (message.entity === 'GameRoom' && message.event.id === roomId) {
            history.push(message.event.data);
        }
    }
    return history;
}

/** How many times a player's `games_won` changed in the socket's events. */
function gamesWonChanges(client, playerId) {
    let changes = 0;
    let previous = null;
    for (const message of eventsOf(client)) {
        if (message.entity !== 'Player' || message.event.id !== playerId) {
            continue;
        }
        const gamesWon = message.event.data.games_won;
        if (previous !== null && gamesWon !== previous) {
            changes += 1;
        }
        previous = gamesWon;
    }
    return changes;
}

function latestOfType(client, type, roomId) {
    const matching = client.log.messages.filter((message) => {
        return message.type === type && message.room_id === roomId;
    });
    return matching.at(-1);
}

function onlineById(presence) {
    const online = {};
    for (const entry of presence.players) {
        online[entry.player_id] = entry.online;
    }
    return online;
}

// --- Scores --------------------------------------------------------------

function score(round, points) {
    return {
        round_number: round,
        cards: [{ value: String(points), type: 'number' }],
        base_sum: points,
        final_score: points,
    };
}

// --- Tests ---------------------------------------------------------------

describe('end-to-end games', () => {
    let server;
    let clock = 1_000_000;
    let players = [];

    before(async () => {
        server = await startTestServer({
            env: { HOST_OFFLINE_GRACE_SECONDS: String(HOST_OFFLINE_GRACE_MS / 1000) },
            realtimeNow: () => clock,
            voteHoldMs: VOTE_HOLD_MS,
        });
    });

    afterEach(async () => {
        for (const player of players) {
            await player.disconnect();
        }
        players = [];
    });

    after(async () => {
        await server.stop();
    });

    // --- Helpers ---------------------------------------------------------

    async function login(names, target = server) {
        const loggedIn = [];
        for (const name of names) {
            const player = await TestPlayer.login(target, name);
            players.push(player);
            loggedIn.push(player);
        }
        return loggedIn;
    }

    /**
     * The first player creates a room and the rest join; then everyone
     * connects from the event-log position before the room existed, so each
     * socket learns the whole room from events (the replay) alone.
     * Returns { roomId, ids: { name: playerId } }.
     */
    async function setUpRoom(roomPlayers, maxScore, target = server) {
        const startPosition = { epoch: target.instance.hub.epoch, lastSeq: target.instance.hub.seq };
        const [creator, ...joiners] = roomPlayers;
        const created = await creator.createRoom({ max_score: maxScore, name: creator.name });
        assert.equal(created.status, 200);
        const roomId = created.body.room.id;
        const ids = { [creator.name]: created.body.player.id };

        for (const joiner of joiners) {
            const joined = await joiner.action(roomId, 'join', { name: joiner.name });
            assert.equal(joined.status, 200);
            ids[joiner.name] = joined.body.player.id;
        }
        for (const player of roomPlayers) {
            await player.connect([roomId], startPosition);
        }
        return { roomId, ids };
    }

    /** Waits until every listed player's socket has the action behind `response`. */
    async function everyoneSees(watchers, roomId, response) {
        assert.equal(response.status, 200, JSON.stringify(response.body));
        for (const watcher of watchers) {
            await watcher.waitForRoomVersion(roomId, response.body.room.version);
        }
    }

    /** Each listed player submits `points[name]` for `round`; everyone waits for each. */
    async function playRound(roomId, submitters, round, points, watchers = submitters) {
        let last;
        for (const player of submitters) {
            last = await player.action(roomId, 'submit-score', score(round, points[player.name]));
            await everyoneSees(watchers, roomId, last);
        }
        return last;
    }

    async function assertModelMatchesServer(watchers, roomId) {
        const expected = await fetchRoomState(watchers[0], roomId);
        for (const watcher of watchers) {
            assertSeqsIncrease(watcher.client);
            assert.deepEqual(modelRoomState(buildModel(watcher.client), roomId), expected, watcher.name);
        }
        return expected;
    }

    /** Plays rounds until the room finishes. Returns the finishing response. */
    async function playToFinish(roomId, roomPlayers, points) {
        let round = 1;
        let response = await playRound(roomId, roomPlayers, round, points);
        while (response.body.room.status === 'playing') {
            assert.ok(round < 20, 'the game should end');
            round += 1;
            response = await playRound(roomId, roomPlayers, round, points);
        }
        return response;
    }

    // --- 1. Full game ----------------------------------------------------

    test('a full game to max_score: one advance per round, the same state on every socket', async () => {
        const roomPlayers = await login(['g1host', 'g1ann', 'g1ben']);
        const [host] = roomPlayers;
        const { roomId, ids } = await setUpRoom(roomPlayers, 100);
        await everyoneSees(roomPlayers, roomId, await host.action(roomId, 'start'));

        const points = { g1host: 30, g1ann: 20, g1ben: 10 };
        const finished = await playToFinish(roomId, roomPlayers, points);
        assert.equal(finished.body.room.status, 'finished');

        const turnOrder = [ids.g1host, ids.g1ann, ids.g1ben];
        for (const player of roomPlayers) {
            const history = roomHistory(player.client, roomId);
            const playing = history.filter((room) => room.status === 'playing');
            // Each round's number appears once in a row, then the next one.
            const rounds = [];
            for (const room of playing) {
                if (rounds.at(-1)?.number !== room.current_round) {
                    rounds.push({ number: room.current_round, turn: room.current_turn_player_id });
                }
            }
            assert.deepEqual(rounds, [
                { number: 1, turn: turnOrder[0] },
                { number: 2, turn: turnOrder[1] },
                { number: 3, turn: turnOrder[2] },
                { number: 4, turn: turnOrder[0] },
            ], player.name);
            assert.equal(history.at(-1).status, 'finished');
            assert.equal(gamesWonChanges(player.client, ids.g1host), 1, player.name);
        }

        const state = await assertModelMatchesServer(roomPlayers, roomId);
        assert.equal(state.room.winner_player_id, ids.g1host);
        assert.equal(state.room.finish_reason, 'max_score');
        assert.equal(state.players.find((player) => player.id === ids.g1host).games_won, 1);

        // A retried last submit doesn't finish the game a second time.
        const retried = await roomPlayers[2].action(roomId, 'submit-score', score(4, points.g1ben));
        const isSafeRetry = retried.status === 409 || retried.body.already_applied === true;
        assert.ok(isSafeRetry, JSON.stringify(retried.body));
        const afterRetry = await fetchRoomState(host, roomId);
        assert.equal(afterRetry.players.find((player) => player.id === ids.g1host).games_won, 1);
    });

    // --- 2. Host disconnects ---------------------------------------------

    test('the host drops mid-round: the round advances, presence goes offline, a vote picks a new host', async () => {
        const roomPlayers = await login(['g2host', 'g2ann', 'g2ben']);
        const [host, ann, ben] = roomPlayers;
        const { roomId, ids } = await setUpRoom(roomPlayers, 500);
        await everyoneSees(roomPlayers, roomId, await host.action(roomId, 'start'));
        await everyoneSees(roomPlayers, roomId, await host.action(roomId, 'submit-score', score(1, 10)));

        // The host's phone loses its connection without a clean close: the
        // socket stays open on the server but sends no more pings.
        const others = [ann, ben];
        const advanced = await playRound(roomId, others, 1, { g2ann: 5, g2ben: 7 }, others);
        assert.equal(advanced.body.room.current_round, 2);

        clock += LIVE_WINDOW_MS + 1_000;
        for (const player of others) {
            await player.ping();
        }
        server.instance.hub.checkLiveness();
        for (const player of others) {
            const presence = await player.waitFor((message) => {
                return message.type === 'presence' && onlineById(message)[ids.g2host] === false;
            });
            assert.deepEqual(onlineById(presence), { [ids.g2host]: false, [ids.g2ann]: true, [ids.g2ben]: true });
        }
        await host.disconnect();

        // Everyone agrees at once, but the vote only starts once the host has
        // been offline for the grace period.
        const voteStart = ann.client.log.messages.length;
        for (const player of others) {
            player.client.send({ type: 'vote-hold', room_id: roomId, topic: 'make-host', option: ids.g2ann });
        }
        const agreed = await ann.waitFor((message) => message.type === 'vote' && message.holds.length === 2, {
            from: voteStart,
        });
        assert.equal(agreed.pending, null);
        assert.ok(agreed.unlocks_in_ms > 0);

        const pending = await ann.waitFor((message) => message.type === 'vote' && message.pending !== null, {
            from: voteStart,
        });
        assert.equal(pending.unlocks_in_ms, 0);
        assert.deepEqual([...pending.eligible].sort(), [ids.g2ann, ids.g2ben].sort());

        for (const player of others) {
            const passed = await player.waitFor((message) => message.type === 'vote-passed');
            assert.equal(passed.option, ids.g2ann);
            const messages = player.client.log.messages;
            const roomEventIndex = messages.findIndex((message) => {
                return message.entity === 'GameRoom' && message.event.data.host_player_id === ids.g2ann;
            });
            assert.ok(roomEventIndex !== -1, 'the host change arrives as an event');
            assert.ok(roomEventIndex < messages.indexOf(passed), 'vote-passed comes after the entity events');
        }

        const state = await assertModelMatchesServer(others, roomId);
        assert.equal(state.room.host_player_id, ids.g2ann);
        assert.equal(state.room.host_email, ann.email);
        assert.equal(state.room.current_round, 2);
    });

    // --- 3. Kick mid-game ------------------------------------------------

    test('a player kicked mid-game stops getting events and no longer blocks the round; a ghost can leave', async () => {
        const roomPlayers = await login(['g3host', 'g3ann', 'g3ben', 'g3cal']);
        const [host, ann, ben, cal] = roomPlayers;
        const { roomId, ids } = await setUpRoom(roomPlayers, 500);
        await everyoneSees(roomPlayers, roomId, await host.action(roomId, 'start'));

        const points = { g3host: 10, g3ann: 20, g3cal: 30 };
        await playRound(roomId, [host, ann, cal], 1, points, roomPlayers);

        // Ben hasn't submitted; kicking him completes round 1.
        const kicked = await host.action(roomId, 'kick', { player_id: ids.g3ben });
        assert.equal(kicked.body.room.current_round, 2);
        await everyoneSees(roomPlayers, roomId, kicked);
        const ownDelete = ben.client.log.messages.find((message) => {
            return message.entity === 'Player' && message.event.type === 'delete';
        });
        assert.equal(ownDelete.event.id, ids.g3ben);
        const benSeenCount = ben.client.log.messages.length;

        // Cal becomes a ghost (gone without submitting), then leaves over REST.
        const remaining = [host, ann];
        await cal.disconnect();
        await playRound(roomId, remaining, 2, points, remaining);
        const left = await cal.action(roomId, 'leave');
        assert.equal(left.body.room.current_round, 3);
        await everyoneSees(remaining, roomId, left);

        // Asking for the room again doesn't resubscribe a non-member.
        ben.client.send({ type: 'rooms', rooms: [roomId] });
        await ben.waitFor((message) => message.type === 'rooms-ok', { from: benSeenCount });
        await everyoneSees(remaining, roomId, await host.action(roomId, 'submit-score', score(3, 1)));
        await ben.ping();
        const lateForBen = ben.client.log.messages.slice(benSeenCount);
        assert.deepEqual(lateForBen.filter((message) => messageRoomId(message) === roomId), []);

        const state = await assertModelMatchesServer(remaining, roomId);
        assert.deepEqual(state.players.map((player) => player.id).sort(), [ids.g3host, ids.g3ann].sort());
    });

    // --- 5. One user, two sockets ----------------------------------------

    test('one user on two sockets is one player; closing one keeps them online and their hold', async () => {
        const roomPlayers = await login(['g5host', 'g5ann', 'g5ben']);
        const [host, ann, ben] = roomPlayers;
        const { roomId, ids } = await setUpRoom(roomPlayers, 500);
        let annSecond = await ann.openSocket([roomId]);

        const hasThreeVoters = (message) => message.type === 'vote' && message.eligible.length === 3;
        await host.waitFor(hasThreeVoters);
        const presence = latestOfType(host.client, 'presence', roomId);
        assert.equal(presence.players.length, 3);
        assert.deepEqual(onlineById(presence), { [ids.g5host]: true, [ids.g5ann]: true, [ids.g5ben]: true });

        const beforeClose = host.client.log.messages.length;
        await annSecond.close();
        // A ping round trip from ann's other socket lets the server settle.
        await ann.ping();
        await host.ping();
        const changes = host.client.log.messages.slice(beforeClose).filter((message) => {
            return message.type === 'presence';
        });
        assert.deepEqual(changes, [], 'closing one of two sockets is not a presence change');

        // Ann holds from her first socket; her second socket closes mid-hold.
        annSecond = await ann.openSocket([roomId]);
        const voteStart = host.client.log.messages.length;
        for (const player of roomPlayers) {
            player.client.send({ type: 'vote-hold', room_id: roomId, topic: 'make-host', option: ids.g5ben });
        }
        await host.waitFor((message) => message.type === 'vote' && message.pending !== null, { from: voteStart });
        await annSecond.close();

        const passed = await host.waitFor((message) => message.type === 'vote-passed', { from: voteStart });
        assert.equal(passed.option, ids.g5ben);
        assert.equal(onlineById(latestOfType(host.client, 'presence', roomId))[ids.g5ann], true);
        const state = await assertModelMatchesServer(roomPlayers, roomId);
        assert.equal(state.room.host_player_id, ids.g5ben);
    });

    // --- 6. Play again ---------------------------------------------------

    test('play again keeps every player, resets the game and can start a new one', async () => {
        const roomPlayers = await login(['g6host', 'g6ann', 'g6ben']);
        const [host] = roomPlayers;
        const { roomId, ids } = await setUpRoom(roomPlayers, 50);
        await everyoneSees(roomPlayers, roomId, await host.action(roomId, 'start'));
        const finished = await playToFinish(roomId, roomPlayers, { g6host: 10, g6ann: 60, g6ben: 5 });
        assert.equal(finished.body.room.winner_player_id, ids.g6ann);

        await everyoneSees(roomPlayers, roomId, await host.action(roomId, 'play-again'));

        const reset = await assertModelMatchesServer(roomPlayers, roomId);
        assert.equal(reset.room.status, 'waiting');
        assert.equal(reset.room.winner_player_id, null);
        assert.equal(reset.room.finish_reason, null);
        assert.equal(reset.room.current_round, 1);
        assert.deepEqual(reset.roundScores, []);
        assert.deepEqual(reset.players.map((player) => player.id).sort(), Object.values(ids).sort());
        for (const player of reset.players) {
            assert.equal(player.total_score, 0);
            assert.equal(player.current_round_score, 0);
            assert.equal(player.has_submitted_round, false);
        }

        await everyoneSees(roomPlayers, roomId, await host.action(roomId, 'start'));
        const next = await playRound(roomId, roomPlayers, 1, { g6host: 1, g6ann: 2, g6ben: 3 });
        assert.equal(next.body.room.status, 'playing');
        assert.equal(next.body.room.current_round, 2);
        const replayed = await assertModelMatchesServer(roomPlayers, roomId);
        assert.equal(replayed.roundScores.length, 3);
    });

    // --- 7. Room scoping -------------------------------------------------

    test('two rooms playing at once never see each other\'s events or chat', async () => {
        const roomAPlayers = await login(['g7host', 'g7ann', 'g7ben']);
        const roomBPlayers = await login(['g7cal', 'g7dan']);
        const roomA = await setUpRoom(roomAPlayers, 500);
        const roomB = await setUpRoom(roomBPlayers, 500);
        // Ann is in both rooms but only subscribes to room A.
        const annInB = await roomAPlayers[1].action(roomB.roomId, 'join', { name: 'g7ann' });
        await everyoneSees(roomBPlayers, roomB.roomId, annInB);

        const games = [
            { roomId: roomA.roomId, watchers: roomAPlayers, submitters: roomAPlayers },
            { roomId: roomB.roomId, watchers: roomBPlayers, submitters: [...roomBPlayers, roomAPlayers[1]] },
        ];
        for (const game of games) {
            await everyoneSees(game.watchers, game.roomId, await game.watchers[0].action(game.roomId, 'start'));
        }

        // Interleave the two games' submits and chat.
        for (let index = 0; index < 3; index += 1) {
            for (const game of games) {
                const submitter = game.submitters[index];
                const response = await submitter.action(game.roomId, 'submit-score', score(1, index + 1));
                await everyoneSees(game.watchers, game.roomId, response);

                const senderId = response.body.players.find((player) => player.email === submitter.email).id;
                const chat = await api(submitter.server.baseUrl, 'POST', '/api/entities/ChatMessage', {
                    cookie: submitter.cookie,
                    body: { room_id: game.roomId, sender_id: senderId, recipient_id: null, emoji: '', message: 'hi' },
                });
                assert.equal(chat.status, 201);
            }
        }
        const lastChatB = await api(server.baseUrl, 'POST', '/api/entities/ChatMessage', {
            cookie: roomBPlayers[0].cookie,
            body: { room_id: roomB.roomId, sender_id: roomB.ids.g7cal, recipient_id: null, emoji: '', message: 'bye' },
        });
        for (const watcher of roomBPlayers) {
            await watcher.waitFor((message) => message.event?.id === lastChatB.body.id);
        }
        // Both rooms are in round 2; room A plays on alone for a bit.
        const roundTwo = await roomAPlayers[0].action(roomA.roomId, 'submit-score', score(2, 9));
        assert.equal(roundTwo.body.room.current_round, 2);
        await everyoneSees(roomAPlayers, roomA.roomId, roundTwo);
        for (const player of roomAPlayers) {
            await player.ping();
        }

        for (const game of games) {
            for (const watcher of game.watchers) {
                const foreign = watcher.client.log.messages.filter((message) => {
                    const roomId = messageRoomId(message);
                    return roomId !== null && roomId !== game.roomId;
                });
                assert.deepEqual(foreign, [], watcher.name);
                const chats = eventsOf(watcher.client).filter((message) => message.entity === 'ChatMessage');
                assert.ok(chats.length >= 3, watcher.name);
            }
            await assertModelMatchesServer(game.watchers, game.roomId);
        }
    });
});

// --- 4. Server restart -----------------------------------------------------

describe('end-to-end game across a server restart', () => {
    let server;
    let players = [];

    before(async () => {
        server = await startTestServer();
    });

    after(async () => {
        for (const player of players) {
            await player.disconnect();
        }
        await server.stop();
    });

    test('clients reconnect with epoch and last_seq and get a replay, then finish the round', async () => {
        for (const name of ['g4host', 'g4ann', 'g4ben']) {
            players.push(await TestPlayer.login(server, name));
        }
        const [host, ann, ben] = players;
        const startPosition = { epoch: server.instance.hub.epoch, lastSeq: server.instance.hub.seq };
        const created = await host.createRoom({ max_score: 500 });
        const roomId = created.body.room.id;
        for (const player of [ann, ben]) {
            await player.action(roomId, 'join', { name: player.name });
        }
        for (const player of players) {
            await player.connect([roomId], startPosition);
        }
        const started = await host.action(roomId, 'start');
        for (const player of players) {
            await player.waitForRoomVersion(roomId, started.body.room.version);
        }

        // Ben drops out, and misses the host's submit.
        await ben.disconnect();
        const missed = await host.action(roomId, 'submit-score', score(1, 12));
        await host.waitForRoomVersion(roomId, missed.body.room.version);
        await ann.waitForRoomVersion(roomId, missed.body.room.version);
        const epochBefore = server.instance.hub.epoch;

        await server.instance.close();
        for (const player of players) {
            await player.disconnect();
        }
        server = await startTestServer({ dataDir: server.dataDir });
        for (const player of players) {
            player.server = server;
        }
        assert.equal(server.instance.hub.epoch, epochBefore, 'the epoch survives a restart');

        for (const player of players) {
            const client = await player.connect([roomId]);
            const types = client.log.messages.map((message) => message.type);
            assert.ok(!types.includes('resync'), `${player.name} got a resync`);
        }
        const benReplay = ben.client.log.messages.slice(0, ben.client.log.messages.findIndex((message) => {
            return message.type === 'ready';
        }));
        const replayedScore = benReplay.find((message) => message.entity === 'RoundScore');
        assert.equal(replayedScore.event.data.final_score, 12);
        assert.ok(benReplay.some((message) => message.room_version === missed.body.room.version));

        let last;
        for (const player of [ann, ben]) {
            last = await player.action(roomId, 'submit-score', score(1, 3));
            assert.equal(last.status, 200);
        }
        assert.equal(last.body.room.current_round, 2);
        for (const player of players) {
            await player.waitForRoomVersion(roomId, last.body.room.version);
            assert.equal(roomHistory(player.client, roomId).at(-1).current_round, 2);
        }
    });
});
