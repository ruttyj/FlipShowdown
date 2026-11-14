// The per-room state a socket needs when it starts listening to a room, after ready (hello) or
// rooms-ok (rooms): the room's presence, each topic's vote and, when there is any, who is entering
// cards. Clients forget their entry list on ready / rooms-ok, so this is what restores it.

export class RoomStateSnapshot {
    #presence;
    #votes;
    #entries;

    /** `presence` is the PresenceManager, `votes` the VoteManager and `entries` the EntryStatusManager. */
    constructor({ presence, votes, entries }) {
        this.#presence = presence;
        this.#votes = votes;
        this.#entries = entries;
    }

    /** Sends the socket each room's state, room by room. `roomIds` is an iterable of room ids. */
    send(socket, roomIds) {
        for (const roomId of roomIds) {
            this.#presence.sendState(socket, roomId);
            this.#votes.sendStates(socket, roomId);
            this.#entries.sendState(socket, roomId);
        }
    }
}
