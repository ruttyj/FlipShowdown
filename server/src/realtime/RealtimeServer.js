import { WebSocketServer } from 'ws';
import { CLIENT_MESSAGE, REALTIME_PATH, SERVER_MESSAGE } from '../../../shared/realtimeProtocol.js';

// The realtime endpoint: the WebSocket upgrade on REALTIME_PATH, with authentication, and each
// accepted socket's life. A socket's messages are parsed and handed to the handler registered for
// their type (SocketHandlerRegistry); ping is answered here, as is the socket closing. Sockets,
// liveness and sending are the ConnectionManager's, and who listens to which room the
// SubscriptionManager's.

const MAX_CLIENT_MESSAGE_BYTES = 16 * 1024;

/** The WebSocketServer the endpoint upgrades into. Its `clients` is the ConnectionManager's set. */
export function createWebSocketServer() {
    return new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES });
}

// --- Upgrade handling ----------------------------------------------------

function getPathname(url) {
    try {
        return new URL(url, 'http://localhost').pathname;
    } catch {
        return null;
    }
}

/** Writes a minimal HTTP error response on a raw upgrade socket and closes it. */
function rejectUpgrade(socket, status, statusText, message) {
    const body = JSON.stringify({ message });
    socket.end(
        `HTTP/1.1 ${status} ${statusText}\r\n`
        + 'Content-Type: application/json\r\n'
        + `Content-Length: ${Buffer.byteLength(body)}\r\n`
        + 'Connection: close\r\n'
        + '\r\n'
        + body,
    );
}

/**
 * Logs and destroys a raw upgrade socket that errored (e.g. ECONNRESET when the
 * browser drops the connection during auth). Without a listener, Node treats
 * the 'error' as an uncaught exception and the whole process exits.
 */
function handleUpgradeSocketError(logger, socket, error) {
    logger.warn(`Realtime upgrade socket error: ${error.message}`);
    socket.destroy();
}

/** The client message in `raw`, or null when it isn't JSON. */
function parseClientMessage(raw) {
    try {
        return JSON.parse(raw.toString());
    } catch {
        return null;
    }
}

// --- Server --------------------------------------------------------------

export class RealtimeServer {
    #webSocketServer;
    #authenticate;
    #logger;
    #connections;
    #subscriptions;
    #presence;
    #votes;
    #handlers;

    /**
     * `webSocketServer` comes from createWebSocketServer. `authenticate(headers)` resolves to the
     * socket's identity ({ email, ... }) or null; `logger` is console-like. `connections` is the
     * ConnectionManager, `subscriptions` the SubscriptionManager, `presence` the PresenceManager,
     * `votes` the VoteManager and `handlers` the SocketHandlerRegistry.
     */
    constructor({ webSocketServer, authenticate, logger, connections, subscriptions, presence, votes, handlers }) {
        this.#webSocketServer = webSocketServer;
        this.#authenticate = authenticate;
        this.#logger = logger;
        this.#connections = connections;
        this.#subscriptions = subscriptions;
        this.#presence = presence;
        this.#votes = votes;
        this.#handlers = handlers;

        webSocketServer.on('connection', (socket) => this.#setUpSocket(socket));
    }

    /** Handles WebSocket upgrades on the HTTP server's REALTIME_PATH. */
    attach(server) {
        server.on('upgrade', (request, socket, head) => {
            this.#handleUpgrade(request, socket, head).catch((error) => {
                this.#logger.error('Realtime upgrade failed', error);
                socket.destroy();
            });
        });
    }

    /** Stops accepting sockets. The ConnectionManager terminates the open ones. */
    close() {
        this.#webSocketServer.close();
    }

    // --- Upgrades ------------------------------------------------------------

    /**
     * Accepts an authenticated upgrade on REALTIME_PATH: an unauthenticated one gets a 401 and
     * never reaches ws, and any other path is destroyed.
     */
    async #handleUpgrade(request, socket, head) {
        // Node drops its own HTTP error listener once a socket is handed to
        // 'upgrade', so attach one before any async work can let an error through.
        const onSocketError = (error) => handleUpgradeSocketError(this.#logger, socket, error);
        socket.on('error', onSocketError);

        if (getPathname(request.url) !== REALTIME_PATH) {
            socket.destroy();
            return;
        }

        let identity = null;
        try {
            identity = await this.#authenticate(request.headers);
        } catch (error) {
            this.#logger.error('Realtime authentication failed', error);
        }
        if (!identity) {
            rejectUpgrade(socket, 401, 'Unauthorized', 'Authentication required');
            return;
        }

        // A socket that errored while auth was pending has already been destroyed.
        if (socket.destroyed) {
            return;
        }

        this.#webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
            // The accepted WebSocket now owns the raw socket's errors (see ConnectionManager#register).
            socket.off('error', onSocketError);
            webSocket.identity = identity;
            this.#webSocketServer.emit('connection', webSocket, request);
        });
    }

    // --- Sockets -------------------------------------------------------------

    #setUpSocket(socket) {
        this.#subscriptions.register(socket);
        this.#connections.register(socket, {
            onMessage: (raw) => this.#handleMessage(socket, raw),
            onClose: () => this.#handleClosed(socket),
        });
    }

    /** Runs the handler for the message's type. Anything else (not JSON, an unknown type) is ignored. */
    #handleMessage(socket, raw) {
        const message = parseClientMessage(raw);
        if (message?.type === CLIENT_MESSAGE.PING) {
            this.#handlePing(socket);
            return;
        }

        const handler = this.#handlers.get(message?.type);
        if (handler) {
            handler.handle(socket, message);
        }
    }

    /** Records a client ping; a socket that had gone stale is live again, so its rooms update. */
    #handlePing(socket) {
        if (this.#connections.markHeard(socket)) {
            this.#presence.refreshRooms(this.#subscriptions.roomsOf(socket));
        }
        this.#connections.send(socket, { type: SERVER_MESSAGE.PONG });
    }

    /** The socket's rooms lose it: its subscription and holds go, and they hear its presence. */
    #handleClosed(socket) {
        const rooms = this.#subscriptions.unsubscribeAll(socket);
        this.#votes.dropAllHolds(socket);
        this.#presence.refreshRooms(rooms);
    }
}
