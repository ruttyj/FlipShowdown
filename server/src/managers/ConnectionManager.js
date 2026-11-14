import { WebSocket } from 'ws';
import { LIVE_WINDOW_MS } from '../../../shared/realtimeProtocol.js';

// The realtime sockets themselves: whether each one is still connected and whether its page is
// live, the heartbeat and liveness timers, sending, and the guard every socket and timer callback
// runs under. It knows nothing about rooms; the hub turns a liveness change into presence updates.
//
// Two separate signals, set on each socket:
//   isAlive     - answered the last WebSocket ping. Only used to terminate dead sockets: the
//                 browser answers pings even for a hidden tab.
//   isLive / lastHeardAt - the client sent a `ping` message within LIVE_WINDOW_MS. This is what
//                 makes a player online.

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const LIVENESS_CHECK_INTERVAL_MS = 5_000;

export class ConnectionManager {
    /**
     * `clients` is the WebSocketServer's live set of sockets, `clock` a Clock and `logger` a
     * console-like object. The intervals are how often the heartbeat pings and how often the
     * periodic check (see startTimers) runs.
     */
    constructor({
        clients,
        clock,
        logger,
        heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
        livenessCheckIntervalMs = LIVENESS_CHECK_INTERVAL_MS,
    }) {
        this.clients = clients;
        this.clock = clock;
        this.logger = logger;
        this.heartbeatIntervalMs = heartbeatIntervalMs;
        this.livenessCheckIntervalMs = livenessCheckIntervalMs;
        this.timers = [];
        this.isClosed = false;
    }

    // --- Sockets -------------------------------------------------------------

    /**
     * Starts tracking a newly connected socket: it counts as alive and live, and its events go to
     * the hooks, each under runGuarded. `hooks` is { onMessage(raw), onClose() }.
     */
    register(socket, { onMessage, onClose }) {
        socket.isAlive = true;
        socket.isLive = true;
        socket.lastHeardAt = this.clock.now();

        socket.on('pong', () => {
            socket.isAlive = true;
        });
        socket.on('message', (raw) => {
            this.runGuarded('message', () => onMessage(raw));
        });
        socket.on('close', () => {
            this.runGuarded('close', onClose);
        });
        socket.on('error', (error) => {
            this.logger.warn(`Realtime socket error: ${error.message}`);
        });
    }

    /** Sends `message` (an object, or text already serialised) if the socket is still open. */
    send(socket, message) {
        if (socket.readyState !== WebSocket.OPEN) {
            return;
        }

        const text = typeof message === 'string' ? message : JSON.stringify(message);
        socket.send(text);
    }

    // --- Liveness ------------------------------------------------------------

    /**
     * Records a client ping. Returns true when the socket had gone stale and is live again, so the
     * caller updates its rooms' presence.
     */
    markHeard(socket) {
        socket.lastHeardAt = this.clock.now();
        if (socket.isLive) {
            return false;
        }

        socket.isLive = true;
        return true;
    }

    /**
     * Marks sockets without a client ping in the last LIVE_WINDOW_MS as not live (and heard ones
     * as live again). Returns the sockets whose liveness changed, in client order.
     */
    updateLiveness() {
        const changed = [];
        for (const socket of this.clients) {
            const isLive = this.clock.now() - socket.lastHeardAt <= LIVE_WINDOW_MS;
            if (isLive === socket.isLive) {
                continue;
            }

            socket.isLive = isLive;
            changed.push(socket);
        }
        return changed;
    }

    // --- Timers and lifecycle --------------------------------------------------

    /**
     * Runs a socket or timer handler, logging a throw instead of crashing the process. Does
     * nothing once the connections are closed, so a late callback can't touch a closed hub.
     */
    runGuarded(label, handler) {
        if (this.isClosed) {
            return;
        }

        try {
            handler();
        } catch (error) {
            this.logger.error(`Realtime ${label} failed`, error);
        }
    }

    /**
     * Starts the heartbeat and the periodic check, which calls `onPeriodicCheck()` under
     * runGuarded. Neither timer keeps the process alive.
     */
    startTimers(onPeriodicCheck) {
        const heartbeatTimer = setInterval(() => this.#heartbeat(), this.heartbeatIntervalMs);
        const livenessTimer = setInterval(() => {
            this.runGuarded('periodic check', onPeriodicCheck);
        }, this.livenessCheckIntervalMs);
        heartbeatTimer.unref();
        livenessTimer.unref();
        this.timers = [heartbeatTimer, livenessTimer];
    }

    /** Stops the timers and terminates every socket. Guarded callbacks are skipped from now on. */
    close() {
        this.isClosed = true;
        for (const timer of this.timers) {
            clearInterval(timer);
        }
        for (const socket of this.clients) {
            socket.terminate();
        }
    }

    /** Terminates sockets that didn't answer the previous ping, then pings the rest. */
    #heartbeat() {
        for (const socket of this.clients) {
            if (!socket.isAlive) {
                socket.terminate();
                continue;
            }
            socket.isAlive = false;
            socket.ping();
        }
    }
}
