import { CLIENT_MESSAGE, SERVER_MESSAGE } from '../../../../shared/realtimeProtocol.js';

/**
 * rooms: replaces the socket's room list without moving its position in the event log. The socket
 * gets rooms-ok, then the state of each room it added; its old and new rooms hear its presence.
 * Message { rooms }.
 */
export class RoomsHandler {
    type = CLIENT_MESSAGE.ROOMS;
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
        // A room list only makes sense once hello has set the socket's position.
        if (!this.#subscriptions.isSubscribed(socket)) {
            return;
        }

        const subscription = this.#subscriptions.resolve(socket.identity, message.rooms);
        const { added, removed, affected } = this.#subscriptions.apply(socket, subscription);
        this.#votes.dropHolds(socket, removed);

        this.#connections.send(socket, { type: SERVER_MESSAGE.ROOMS_OK, seq: this.#publisher.seq });
        this.#presence.refreshRooms(affected, { skipSocket: socket });
        this.#roomStates.send(socket, added);
    }
}
