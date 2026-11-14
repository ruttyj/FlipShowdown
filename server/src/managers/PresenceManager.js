import { SERVER_MESSAGE } from '../../../shared/realtimeProtocol.js';
import { summariseRoomStats } from './roomStats.js';

// Who is online in each room, and the `presence` message that tells the room. A player is online
// while one of their live sockets explicitly subscribes to the room; an admin "*" socket is
// watching, not playing. The last presence sent is cached per room, for as long as anyone
// subscribes to it, to spot changes, and it is what the votes, the launcher's stats and the stale
// room sweep read.
//
// A presence player is { player_id, online, last_seen } as the message carries it. last_seen is
// written to the Player when they go offline, without an entity event: the presence message
// carries it.

// --- Presence player lists ---------------------------------------------------

/** The ids of the online players in a presence player list. */
export function onlinePlayerIdsOf(presencePlayers) {
    const ids = [];
    for (const player of presencePlayers) {
        if (player.online) {
            ids.push(player.player_id);
        }
    }
    return ids;
}

/** When the offline host was last seen, in ms; null when the host is online or never seen. */
export function hostOfflineSinceOf(presencePlayers, hostPlayerId) {
    const host = presencePlayers.find((player) => player.player_id === hostPlayerId);
    if (!host || host.online || !host.last_seen) {
        return null;
    }
    return Date.parse(host.last_seen);
}

// --- Manager -------------------------------------------------------------------

export class PresenceManager {
    /**
     * `rooms` reads GameRooms ({ get(roomId) }) and `players` Players ({ listByRoom(roomId),
     * update(playerId, changes) }). `clock` is the hub's Clock, `connections` the
     * ConnectionManager and `subscriptions` the SubscriptionManager.
     *
     * Hooks: `onStatsChanged()` runs when a room's presence changed, since who is online is what
     * the launcher counts (X66). `onRefreshed(roomId, presencePlayers, { force, skipSocket })`
     * ends every refresh; the hub refreshes the room's votes there, since the voters are the
     * online players.
     */
    constructor({ rooms, players, clock, connections, subscriptions, onStatsChanged, onRefreshed }) {
        this.rooms = rooms;
        this.players = players;
        this.clock = clock;
        this.connections = connections;
        this.subscriptions = subscriptions;
        this.onStatsChanged = onStatsChanged;
        this.onRefreshed = onRefreshed;
        // roomId -> { players, text } as last sent, to detect changes.
        this.cache = new Map();
    }

    // --- Refreshing --------------------------------------------------------------

    /**
     * Recomputes a room's presence and sends it to the room's sockets when it changed (or always,
     * with `force`), then hands it to onRefreshed. `skipSocket` is left out because the caller
     * sends it the state itself, in the right order after ready / rooms-ok.
     */
    refresh(roomId, { force = false, skipSocket = null } = {}) {
        const previous = this.cache.get(roomId);
        const players = this.#buildPlayers(roomId);
        this.#recordWentOffline(previous?.players ?? [], players);

        const text = JSON.stringify({ type: SERVER_MESSAGE.PRESENCE, room_id: roomId, players });
        const hasChanged = text !== previous?.text;

        // Nobody is watching the room any more, so there is no transition to track.
        if (this.subscriptions.hasSubscribers(roomId)) {
            this.cache.set(roomId, { players, text });
        } else {
            this.cache.delete(roomId);
        }

        if (hasChanged || force) {
            this.subscriptions.sendToRoom(roomId, text, skipSocket);
            this.onStatsChanged();
        }
        this.onRefreshed(roomId, players, { force, skipSocket });
    }

    /** refresh for each room id in `roomIds` (an iterable), in order. */
    refreshRooms(roomIds, options) {
        for (const roomId of roomIds) {
            this.refresh(roomId, options);
        }
    }

    /**
     * Emails with a live socket explicitly subscribed to the room. Admin "*" sockets are
     * watching, not playing, so they don't make anyone online.
     */
    #onlineEmails(roomId) {
        const emails = new Set();
        for (const socket of this.connections.clients) {
            const isOnlineHere = this.subscriptions.isExplicitlySubscribed(socket, roomId)
                && this.connections.isLive(socket);
            if (isOnlineHere) {
                emails.add(socket.identity.email);
            }
        }
        return emails;
    }

    #buildPlayers(roomId) {
        const online = this.#onlineEmails(roomId);
        const players = [];
        for (const player of this.players.listByRoom(roomId)) {
            players.push({
                player_id: player.id,
                online: online.has(player.email),
                last_seen: player.last_seen ?? null,
            });
        }
        return players;
    }

    /**
     * Writes Player.last_seen for players who were online and now aren't, and puts the new value
     * in `players`.
     */
    #recordWentOffline(previousPlayers, players) {
        const wasOnline = new Set(onlinePlayerIdsOf(previousPlayers));
        const timestamp = new Date(this.clock.now()).toISOString();
        for (const player of players) {
            if (!player.online && wasOnline.has(player.player_id)) {
                this.players.update(player.player_id, { last_seen: timestamp });
                player.last_seen = timestamp;
            }
        }
    }

    // --- Reading -----------------------------------------------------------------

    /** The room's cached presence players, or null when nobody subscribes to the room. */
    playersOf(roomId) {
        return this.cache.get(roomId)?.players ?? null;
    }

    /** Whether any of the room's players has a live socket subscribed to it right now. */
    hasPlayersOnline(roomId) {
        const players = this.playersOf(roomId);
        if (!players) {
            return false;
        }
        return players.some((player) => player.online);
    }

    /** Sends the socket the room's cached presence message, if there is one. */
    sendState(socket, roomId) {
        const presence = this.cache.get(roomId);
        if (presence) {
            this.connections.send(socket, presence.text);
        }
    }

    /** The launcher's room stats (roomStats.js). */
    buildRoomStats() {
        return summariseRoomStats({
            getRoom: (roomId) => this.rooms.get(roomId),
            presence: this.cache,
            clients: this.connections.clients,
        });
    }
}
