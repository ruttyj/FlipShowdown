import { SERVER_MESSAGE } from '../../../shared/realtimeProtocol.js';
import { isHostPlayer } from '../domain/players.js';
import { hostOfflineSinceOf, onlinePlayerIdsOf } from './PresenceManager.js';
import { createVoteTracker } from './support/voteTracker.js';

// Hold-to-vote in the rooms (docs/backend-contract.md): the vote tracker (support/voteTracker.js)
// per room, fed with who is online and who is host, the vote-hold / vote-release messages, the
// `vote` state each room hears, and running a passed vote's action.
//
// A passed vote's action re-enters the hub synchronously: its publishing, membership and host
// changes refresh presence and votes before the action returns.

/** The room's host Player id, or null when the room or its host is gone. */
function hostPlayerIdOf(room, players) {
    if (!room) {
        return null;
    }
    const host = players.find((player) => isHostPlayer(room, player));
    return host?.id ?? null;
}

export class VoteManager {
    #rooms;
    #players;
    #connections;
    #subscriptions;
    #presence;
    #logger;
    #voteTopics;
    #tracker;

    /**
     * `rooms` reads GameRooms ({ get(roomId) }) and `players` Players ({ listByRoom(roomId) }).
     * `clock` is the hub's Clock, `connections` the ConnectionManager, `subscriptions` the
     * SubscriptionManager, `presence` the PresenceManager (its cached players), `lifecycle` the
     * hub's Lifecycle (the tracker's callbacks run under its guard) and `logger` console-like.
     *
     * `voteTopics` is the topic registry, topic -> { validateOption, resolve, hostDecides } (see
     * actions/VoteTopics.js). `holdMs` is how long a vote must be held, `hostGraceMs` how long the
     * host must be offline before a vote can pass without them; left undefined, they take the
     * vote tracker's defaults (VOTE_HOLD_MS, HOST_OFFLINE_GRACE_MS in support/voteTracker.js).
     */
    constructor({
        rooms,
        players,
        clock,
        connections,
        subscriptions,
        presence,
        lifecycle,
        logger,
        voteTopics,
        holdMs,
        hostGraceMs,
    }) {
        this.#rooms = rooms;
        this.#players = players;
        this.#connections = connections;
        this.#subscriptions = subscriptions;
        this.#presence = presence;
        this.#logger = logger;
        this.#voteTopics = voteTopics;

        const topics = Object.keys(voteTopics);
        this.#tracker = createVoteTracker({
            topics,
            hostDecidesTopics: topics.filter((topic) => voteTopics[topic].hostDecides === true),
            holdMs,
            hostGraceMs,
            now: () => clock.now(),
            onPassed: (roomId, topic, option) => {
                lifecycle.runGuarded('vote', () => this.#runPassedVote(roomId, topic, option));
            },
            onChanged: (changes) => {
                lifecycle.runGuarded('vote unlock', () => this.#broadcast(changes));
            },
        });
    }

    // --- Electorate ----------------------------------------------------------------

    /**
     * Feeds the room's online players and host to the tracker, and broadcasts the topics that
     * changed. `presencePlayers` is the room's fresh presence (PresenceManager#refresh). `force`
     * is for joins, leaves and kicks, which cancel a pending vote even when the online players
     * stay the same. A room nobody subscribes to any more is forgotten.
     */
    refreshRoom(roomId, presencePlayers, { force = false, skipSocket = null } = {}) {
        if (!this.#subscriptions.hasSubscribers(roomId)) {
            this.#tracker.forgetRoom(roomId);
            return;
        }

        const room = this.#rooms.get(roomId);
        const hostPlayerId = hostPlayerIdOf(room, this.#players.listByRoom(roomId));
        const electorate = {
            onlinePlayerIds: onlinePlayerIdsOf(presencePlayers),
            hostPlayerId,
            hostOfflineSince: hostOfflineSinceOf(presencePlayers, hostPlayerId),
        };
        const changes = this.#tracker.setElectorate(roomId, electorate, { force });
        this.#broadcast(changes, skipSocket);
    }

    /**
     * After the room's host changed without a membership change (for example make-host). A
     * vote's voter minimum depends on whether the host is online, so the room's votes are
     * re-evaluated against its cached presence.
     */
    roomHostChanged(roomId) {
        const presencePlayers = this.#presence.playersOf(roomId);
        if (presencePlayers) {
            this.refreshRoom(roomId, presencePlayers);
        }
    }

    // --- Holds -------------------------------------------------------------------

    /** A vote-hold message: checks it, records the hold and tells the room, or replies with a vote-error. */
    hold(socket, message) {
        const voter = this.#resolveVoter(socket, message);
        if (!voter) {
            return;
        }

        const room = this.#rooms.get(voter.roomId);
        const players = this.#players.listByRoom(voter.roomId);
        const isValid = typeof message.option === 'string'
            && this.#voteTopics[voter.topic].validateOption(room, players, message.option);
        if (!isValid) {
            this.#sendError(socket, message, 'invalid_option');
            return;
        }

        const changes = this.#tracker.hold(voter.roomId, voter.topic, {
            socketId: socket,
            playerId: voter.player.id,
            option: message.option,
        });
        this.#broadcast(changes);
    }

    /** A vote-release message: drops the socket's hold in that topic, or replies with a vote-error. */
    release(socket, message) {
        const voter = this.#resolveVoter(socket, message);
        if (!voter) {
            return;
        }
        this.#broadcast(this.#tracker.release(voter.roomId, voter.topic, socket));
    }

    /** A socket that unsubscribed from `roomIds` (an array) lets go of its holds there. */
    dropHolds(socket, roomIds) {
        if (roomIds.length === 0) {
            return;
        }
        this.#broadcast(this.#tracker.dropSocket(socket, roomIds));
    }

    /** A closed socket lets go of its holds in every room. */
    dropAllHolds(socket) {
        this.#broadcast(this.#tracker.dropSocket(socket));
    }

    /**
     * Drops the socket's holds in the room without telling anyone: for a socket whose user left
     * the room, where the caller's forced presence refresh then sends every topic.
     */
    forgetHolds(socket, roomId) {
        this.#tracker.dropSocket(socket, [roomId]);
    }

    // --- Sending -------------------------------------------------------------------

    /** Sends the socket the room's `vote` state for every topic. */
    sendStates(socket, roomId) {
        for (const topic of Object.keys(this.#voteTopics)) {
            this.#connections.send(socket, this.#buildMessage(roomId, topic));
        }
    }

    #buildMessage(roomId, topic) {
        return { type: SERVER_MESSAGE.VOTE, room_id: roomId, topic, ...this.#tracker.snapshot(roomId, topic) };
    }

    /** Sends the `vote` state for each changed { roomId, topic } to its room. */
    #broadcast(changes, skipSocket = null) {
        for (const { roomId, topic } of changes) {
            this.#subscriptions.sendToRoom(roomId, this.#buildMessage(roomId, topic), skipSocket);
        }
    }

    #sendError(socket, message, code) {
        this.#connections.send(socket, {
            type: SERVER_MESSAGE.VOTE_ERROR,
            room_id: message.room_id ?? null,
            topic: message.topic ?? null,
            code,
        });
    }

    // --- Messages and passing ------------------------------------------------------

    /**
     * Checks a vote-hold / vote-release and finds the sender's Player. Returns
     * { roomId, topic, player }, or null after replying with a vote-error.
     */
    #resolveVoter(socket, message) {
        const { room_id: roomId, topic } = message;
        const hasFields = typeof roomId === 'string' && typeof topic === 'string';
        if (!hasFields) {
            this.#sendError(socket, message, 'bad_request');
            return null;
        }
        if (!Object.hasOwn(this.#voteTopics, topic)) {
            this.#sendError(socket, message, 'unknown_topic');
            return null;
        }

        const player = this.#subscriptions.findSubscribedPlayer(socket, roomId);
        if (!player) {
            this.#sendError(socket, message, 'not_member');
            return null;
        }
        return { roomId, topic, player };
    }

    /**
     * The tracker's timer fired: everyone held `option` for the whole hold time, and the topic's
     * holds are already cleared. Re-checks the option against the room as it is now (it may have
     * closed meanwhile), sends the cleared vote state, then runs the topic's action. vote-passed
     * goes out only once the action succeeded, after its entity events. A host change
     * re-evaluates the votes through the action's publishing (see roomHostChanged).
     */
    #runPassedVote(roomId, topic, option) {
        const definition = this.#voteTopics[topic];
        const room = this.#rooms.get(roomId);
        const isStillValid = definition.validateOption(room, this.#players.listByRoom(roomId), option);

        this.#broadcast([{ roomId, topic }]);
        if (!isStillValid) {
            return;
        }

        const result = definition.resolve(roomId, option);
        if (result.status !== 200) {
            this.#logger.warn(`Vote ${topic} in room ${roomId} failed: ${result.body.code}`);
            return;
        }
        const passed = { type: SERVER_MESSAGE.VOTE_PASSED, room_id: roomId, topic, option };
        this.#subscriptions.sendToRoom(roomId, passed);
    }

    /** Cancels every vote timer (the hub is closing). */
    close() {
        this.#tracker.close();
    }
}
