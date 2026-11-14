import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';

// Shared fakes for the realtime manager unit tests (this file contains no tests of its own): a
// socket that records what it was sent, a logger that records its calls, and stand-ins for the
// ConnectionManager and the Player reads.

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

/** A ConnectionManager stand-in for the managers that only need its clients, send and guard. */
export function createFakeConnections(sockets = []) {
    return {
        clients: new Set(sockets),
        send(socket, message) {
            const text = typeof message === 'string' ? message : JSON.stringify(message);
            socket.send(text);
        },
        runGuarded(label, handler) {
            handler();
        },
    };
}

/** A Player reader over a fixed list of records: { listByRoom, listByUserEmail }. */
export function createPlayerReader(players) {
    return {
        listByRoom: (roomId) => players.filter((player) => player.room_id === roomId),
        listByUserEmail: (email) => players.filter((player) => player.email === email),
    };
}
