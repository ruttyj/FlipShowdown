// Which rooms each realtime socket listens to, and the access rules for them. A socket subscribes
// with a room list in hello / rooms; the list is checked against the user's Players, and the
// result is kept on the socket:
//   isSubscribed - hello has set the socket's position, so it receives events
//   rooms        - Set of room ids the user is a player in and asked for
//   allRooms     - the socket asked for "*" and is an admin: it watches every room
//
// A Player's email comes from the users table, so it is canonical: the same spelling auth gives
// socket identities (email.js). Plain === compares them.

const ALL_ROOMS = '*';

export class SubscriptionManager {
    /**
     * `connections` is the ConnectionManager (its `clients` and `send`). `players` reads Player
     * records: { listByRoom(roomId), listByUserEmail(email) }, as PlayerRepository has them.
     * `isAdmin(identity)` says whether a socket's identity may subscribe to "*".
     */
    constructor({ connections, players, isAdmin }) {
        this.connections = connections;
        this.players = players;
        this.isAdmin = isAdmin;
    }

    // --- Subscribing -----------------------------------------------------------

    /** Starts a new socket with no subscription: it receives nothing until hello. */
    register(socket) {
        socket.isSubscribed = false;
        socket.rooms = new Set();
        socket.allRooms = false;
    }

    /**
     * Turns a client's requested room list into { rooms: Set, allRooms }. Rooms the user isn't a
     * member of are dropped, and "*" only counts for admins.
     */
    resolve(identity, requested) {
        const subscription = { rooms: new Set(), allRooms: false };
        if (!Array.isArray(requested)) {
            return subscription;
        }

        const memberRooms = this.#roomIdsOfUser(identity.email);
        for (const roomId of requested) {
            if (roomId === ALL_ROOMS) {
                subscription.allRooms = this.isAdmin(identity);
                continue;
            }
            if (memberRooms.has(roomId)) {
                subscription.rooms.add(roomId);
            }
        }
        return subscription;
    }

    /** Ids of the rooms where this (normalised) email has a Player. */
    #roomIdsOfUser(email) {
        const roomIds = new Set();
        for (const player of this.players.listByUserEmail(email)) {
            if (typeof player.room_id === 'string') {
                roomIds.add(player.room_id);
            }
        }
        return roomIds;
    }

    /**
     * Replaces the socket's subscription. Returns { added, removed, affected }: the rooms that
     * were added and removed (arrays), and every room whose presence may have changed (a Set of
     * the old and new rooms).
     */
    apply(socket, subscription) {
        const previousRooms = socket.rooms;
        const added = [];
        for (const roomId of subscription.rooms) {
            if (!previousRooms.has(roomId)) {
                added.push(roomId);
            }
        }

        const removed = [];
        for (const roomId of previousRooms) {
            if (!subscription.rooms.has(roomId)) {
                removed.push(roomId);
            }
        }

        socket.rooms = subscription.rooms;
        socket.allRooms = subscription.allRooms;
        socket.isSubscribed = true;

        const affected = new Set([...previousRooms, ...subscription.rooms]);
        return { added, removed, affected };
    }

    /** Drops the closed socket's whole subscription. Returns the rooms it was in. */
    unsubscribeAll(socket) {
        const rooms = socket.rooms;
        socket.isSubscribed = false;
        socket.rooms = new Set();
        socket.allRooms = false;
        return rooms;
    }

    /**
     * After the room's players changed: drops the room from every socket whose user is no longer
     * one of them. Returns those sockets.
     */
    dropNonMembers(roomId) {
        const dropped = [];
        for (const socket of this.connections.clients) {
            const isDropped = socket.rooms.has(roomId)
                && !this.isMember(socket.identity.email, roomId);
            if (isDropped) {
                socket.rooms.delete(roomId);
                dropped.push(socket);
            }
        }
        return dropped;
    }

    // --- Membership and access ---------------------------------------------------

    /** Whether hello has set the socket's position, so it receives events. */
    isSubscribed(socket) {
        return socket.isSubscribed;
    }

    /** The rooms the socket named itself (a Set; empty before hello and for "*" alone). */
    roomsOf(socket) {
        return socket.rooms;
    }

    /** Whether the socket is an admin's watching every room through "*". */
    watchesAllRooms(socket) {
        return socket.allRooms;
    }

    /** Whether this (normalised) email has a Player in the room. */
    isMember(email, roomId) {
        return this.players.listByRoom(roomId).some((player) => player.email === email);
    }

    /**
     * Whether an event for `roomId` reaches this socket. Explicit room subscriptions were
     * membership-checked, so they may also see chat. Admin "*" sockets see everything except chat
     * for rooms they aren't in.
     */
    canReceive(socket, roomId, entity) {
        if (!socket.isSubscribed) {
            return false;
        }
        if (socket.rooms.has(roomId)) {
            return true;
        }
        if (!socket.allRooms) {
            return false;
        }
        if (entity === 'ChatMessage') {
            return this.isMember(socket.identity.email, roomId);
        }
        return true;
    }

    /** Whether the socket gets the room's messages, explicitly or through "*". */
    isSubscribedToRoom(socket, roomId) {
        return socket.isSubscribed && (socket.rooms.has(roomId) || socket.allRooms);
    }

    /** Whether the socket named the room itself; an admin "*" socket is watching, not playing. */
    isExplicitlySubscribed(socket, roomId) {
        return socket.isSubscribed && socket.rooms.has(roomId);
    }

    /**
     * Whether any socket explicitly subscribes to the room. Admin "*" sockets don't count:
     * otherwise a deleted room's vote and presence state would be kept for as long as an admin
     * stays connected.
     */
    hasSubscribers(roomId) {
        for (const socket of this.connections.clients) {
            if (this.isExplicitlySubscribed(socket, roomId)) {
                return true;
            }
        }
        return false;
    }

    /**
     * The sender's Player in the room, or null. Only explicit subscriptions count: an admin "*"
     * socket is watching, not playing.
     */
    findSubscribedPlayer(socket, roomId) {
        if (!this.isExplicitlySubscribed(socket, roomId)) {
            return null;
        }

        const player = this.players.listByRoom(roomId).find((candidate) => {
            return candidate.email === socket.identity.email;
        });
        return player ?? null;
    }

    // --- Sending -----------------------------------------------------------------

    /**
     * Sends `message` (an object, or text already serialised) to every socket subscribed to the
     * room, except `skipSocket`. An object is serialised once for the whole room.
     */
    sendToRoom(roomId, message, skipSocket = null) {
        const text = typeof message === 'string' ? message : JSON.stringify(message);
        for (const socket of this.connections.clients) {
            if (socket !== skipSocket && this.isSubscribedToRoom(socket, roomId)) {
                this.connections.send(socket, text);
            }
        }
    }
}
