import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';

// Shared fakes for the realtime manager unit tests (this file contains no tests of its own): a
// socket that records what it was sent, a logger that records its calls, and stand-ins for the
// ConnectionManager and the GameRoom and Player reads.

/** A WebSocket stand-in: records sent text, pings and terminations, and emits events on demand. */
export class FakeSocket extends EventEmitter {
    constructor(email = 'ann@example.com') {
        super();
        this.identity = { email };
        this.readyState = WebSocket.OPEN;
        this.sent = [];
        this.pings = 0;
        this.isTerminated = false;
    }

    send(text) {
        this.sent.push(text);
    }

    ping() {
        this.pings += 1;
    }

    terminate() {
        this.isTerminated = true;
    }

    /** The sent messages, parsed. */
    messages() {
        return this.sent.map((text) => JSON.parse(text));
    }
}

/** A console-like logger that keeps each call as [level, ...args]. */
export function createRecordingLogger() {
    const calls = [];
    return {
        calls,
        log: (...args) => calls.push(['log', ...args]),
        warn: (...args) => calls.push(['warn', ...args]),
        error: (...args) => calls.push(['error', ...args]),
    };
}

/**
 * A ConnectionManager stand-in for the managers that only need its clients, send and isLive.
 * isLive reads the socket's `isLive` flag, which the test sets.
 */
export function createFakeConnections(sockets = []) {
    return {
        clients: new Set(sockets),
        send(socket, message) {
            const text = typeof message === 'string' ? message : JSON.stringify(message);
            socket.send(text);
        },
        isLive(socket) {
            return socket.isLive;
        },
    };
}

/**
 * A Player store over a fixed list of records, shaped like PlayerRepository's: { listByRoom,
 * listByUserEmail, update }. `update` changes the record in the list and counts as a write.
 */
export function createFakePlayers(players) {
    const writes = [];
    return {
        writes,
        listByRoom: (roomId) => players.filter((player) => player.room_id === roomId),
        listByUserEmail: (email) => players.filter((player) => player.email === email),
        update(playerId, changes) {
            writes.push([playerId, changes]);
            Object.assign(players.find((player) => player.id === playerId), changes);
        },
    };
}

/** A GameRoom store over a fixed list of records, shaped like RoomRepository's: { get }. */
export function createFakeRooms(rooms) {
    return {
        get: (roomId) => rooms.find((room) => room.id === roomId) ?? null,
    };
}
