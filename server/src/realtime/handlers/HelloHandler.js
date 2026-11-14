import { CLIENT_MESSAGE, SERVER_MESSAGE } from '../../../../shared/realtimeProtocol.js';

/**
 * hello: sets the socket's position in the event log and its rooms. The socket gets the events it
 * missed (or a resync), then ready, then each room's state; the rest of its rooms hear its
 * presence. Message { epoch, last_seq, rooms }.
 */
export class HelloHandler {
    type = CLIENT_MESSAGE.HELLO;
    #connections;
    #subscriptions;
    #publisher;
    #presence;
    #votes;
    #roomStates;

    /**
     * `connections` is the ConnectionManager, `subscriptions` the SubscriptionManager, `publisher`
     * the EventPublisher, `presence` the PresenceManager, `votes` the VoteManager and `roomStates`
     * the RoomStateSnapshot.
     */
    constructor({ connections, subscriptions, publisher, presence, votes, roomStates }) {
        this.#connections = connections;
        this.#subscriptions = subscriptions;
        this.#publisher = publisher;
        this.#presence = presence;
        this.#votes = votes;
        this.#roomStates = roomStates;
    }

    handle(socket, message) {
        const subscription = this.#subscriptions.resolve(socket.identity, message.rooms);
        const outcome = this.#publisher.classifyHello(message.epoch, message.last_seq);
        // Everything from here to ready runs in one tick, so no live event can
        // slip between the replay and the socket receiving live events.
        const { removed, affected } = this.#subscriptions.apply(socket, subscription);
        this.#votes.dropHolds(socket, removed);

        if (outcome === 'resync') {
            this.#connections.send(socket, { type: SERVER_MESSAGE.RESYNC });
        }
        if (outcome === 'replay') {
            this.#publisher.replay(socket, message.last_seq);
        }

        const ready = { type: SERVER_MESSAGE.READY, epoch: this.#publisher.epoch, seq: this.#publisher.seq };
        this.#connections.send(socket, ready);
        this.#presence.refreshRooms(affected, { skipSocket: socket });
        this.#roomStates.send(socket, subscription.rooms);
    }
}
