// Shared realtime connection (see "Realtime" in docs/backend-contract.md).
//
// One WebSocket serves every `backend.entities.<Name>.subscribe()` call plus the room-level
// messages (presence, votes, entry status). It opens on the first entity subscribe, reconnects with capped
// exponential backoff, and resumes the event stream by sending `hello { epoch, last_seq, rooms }`
// so the server can replay missed events.
//
// Phones suspend sockets while asleep and leave half-open sockets behind after a network
// switch, so the connection also:
// - gives up on a connect that hasn't opened within 10 s;
// - "wakes" (reconnects now, or pings an open socket) when the page becomes visible, is
//   restored from the back/forward cache, resumes, or the network comes back or changes;
// - pings every 10 s while visible and replaces a socket whose pong doesn't arrive;
// - after 3 failed connects in a row, asks `/api/auth/me` whether the session is still
//   valid, and stops retrying ("signed-out") when it isn't.

import {
    CLIENT_MESSAGE,
    PING_INTERVAL_MS,
    REALTIME_PATH,
    SERVER_MESSAGE,
} from '../../shared/realtimeProtocol.js';

const CONNECTING = 0; // WebSocket.CONNECTING / OPEN, hard-coded so test doubles
const OPEN = 1; //       don't need the statics

const CONNECT_TIMEOUT_MS = 10_000;
// A socket must stay ready this long before the failure counters reset; a server that
// sends `ready` and then closes at once is still a failing connection.
const STABLE_READY_MS = 5_000;
// The server counts a socket as live for 15 s after a ping, so a pong slower than this
// already means presence shows us offline.
const PONG_TIMEOUT_MS = 5_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
// Grace period before closing an unused socket, so a component that unsubscribes and
// immediately resubscribes (effect re-run) doesn't churn the connection.
const IDLE_CLOSE_DELAY_MS = 5_000;
// Ask the server whether we're still signed in after this many failed connects in a row.
const AUTH_CHECK_EVERY_FAILURES = 3;
const AUTH_CHECK_PATH = '/api/auth/me';

const VOTE_MESSAGE_TYPES = new Set([SERVER_MESSAGE.VOTE, SERVER_MESSAGE.VOTE_PASSED, SERVER_MESSAGE.VOTE_ERROR]);

/**
 * @typedef {'connecting' | 'live' | 'reconnecting' | 'signed-out'} RealtimeStatus
 * connecting:   no connection has reached `ready` yet
 * live:         `ready` received on the current socket
 * reconnecting: was live, the socket was lost and a new one is (being) opened
 * signed-out:   the session is invalid; no retries until a wake event or a page reload
 */

// --- Helpers -----------------------------------------------------------------

/** Builds the realtime URL for the current page, e.g. https://host -> wss://host/api/realtime */
export function realtimeUrlFor(location) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}${REALTIME_PATH}`;
}

/**
 * Delay before reconnect attempt number `attempt` (0-based): 500ms doubling up to 10s,
 * scaled by a random 50-100% so many clients waking at once don't reconnect in lockstep.
 */
export function reconnectDelay(attempt, random = Math.random) {
    const exponential = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
    return Math.round(exponential * (0.5 + random() * 0.5));
}

/** Calls a listener without letting its errors (sync or async) reach other listeners. */
function callSafely(callback, args, label) {
    const logError = (error) => {
        console.error(`[realtime] ${label} listener failed:`, error);
    };

    try {
        const result = callback(...args);
        if (result && typeof result.then === 'function') {
            result.then(undefined, logError);
        }
    } catch (error) {
        logError(error);
    }
}

function parseMessage(raw) {
    try {
        return JSON.parse(raw);
    } catch {
        console.warn('[realtime] Ignoring non-JSON message:', raw);
        return null;
    }
}

/**
 * True when an `/api/auth/me` response means the session is gone: a 401, or (with
 * `redirect: 'manual'`) a redirect to an external login page such as Cloudflare Access.
 */
function isSignedOutResponse(response) {
    return response.status === 401 || response.type === 'opaqueredirect';
}

function areSameList(first, second) {
    if (first.length !== second.length) {
        return false;
    }
    return first.every((item, index) => item === second[index]);
}

/** A set of listener callbacks; `add` returns an idempotent off(). */
class ListenerSet {
    constructor(label) {
        this.label = label;
        this.entries = new Set();
    }

    get size() {
        return this.entries.size;
    }

    add(callback) {
        // Wrapped so the same function can be added twice and removed independently.
        const entry = { callback };
        this.entries.add(entry);

        let isActive = true;
        return () => {
            if (!isActive) {
                return;
            }
            isActive = false;
            this.entries.delete(entry);
        };
    }

    emit(...args) {
        // Copy first: a listener may add or remove listeners while we iterate.
        for (const entry of [...this.entries]) {
            callSafely(entry.callback, args, this.label);
        }
    }
}

// --- Connection ----------------------------------------------------------------

export class RealtimeConnection {
    /**
     * @param {object} options
     * @param {string} options.url                 WebSocket URL
     * @param {typeof WebSocket} options.WebSocketImpl
     * @param {{ window?: EventTarget, document?: Document, navigator?: Navigator }} [options.environment]
     *        where to listen for wake-up and page lifecycle events; omit in tests that don't need them
     * @param {typeof fetch | null} [options.fetchImpl]  used for the signed-out check; null skips it
     * @param {() => void} [options.reload]        reloads the page on `resync` when nobody listens for it
     */
    constructor({ url, WebSocketImpl, environment = {}, fetchImpl = null, reload = () => {} }) {
        this.url = url;
        this.WebSocketImpl = WebSocketImpl;
        this.environment = environment;
        this.fetchImpl = fetchImpl;
        this.reload = reload;

        // entity name -> ListenerSet of entity callbacks
        this.listenersByEntity = new Map();
        this.readyListeners = new ListenerSet('ready');
        this.resyncListeners = new ListenerSet('resync');
        this.statusListeners = new ListenerSet('status');
        this.presenceListeners = new ListenerSet('presence');
        this.voteListeners = new ListenerSet('vote');
        this.entryStatusListeners = new ListenerSet('entry-status');

        this.rooms = [];
        // True after `pagehide` emptied the server's room list for the still-open socket.
        this.areRoomsReleased = false;
        // The rooms the current socket's `hello` carried.
        this.helloRooms = [];

        this.socket = null;
        this.isSocketReady = false;
        this.connectStartedAt = 0;
        this.epoch = null;
        this.lastSeq = null;

        /** @type {RealtimeStatus} */
        this.status = 'connecting';
        this.hasBeenLive = false;
        this.reconnectAttempts = 0;
        this.failedConnects = 0;
        // Bumped whenever a pending auth check's answer stops being relevant.
        this.authCheckGeneration = 0;

        this.connectTimer = null;
        this.reconnectTimer = null;
        this.pingTimer = null;
        this.pongTimer = null;
        this.idleTimer = null;
        this.stableTimer = null;
        this.isLifecycleAttached = false;
    }

    // --- Public API ------------------------------------------------------------

    /**
     * Registers a callback for one entity's events; returns an idempotent unsubscribe().
     * The callback receives `(event, { room_version, seq })`.
     */
    subscribe(entity, callback) {
        const isFreshSubscribe = !this.hasListeners();
        let listeners = this.listenersByEntity.get(entity);
        if (!listeners) {
            listeners = new ListenerSet(entity);
            this.listenersByEntity.set(entity, listeners);
        }

        const off = listeners.add(callback);
        this.cancelIdleClose();
        this.start(isFreshSubscribe);

        let isSubscribed = true;
        return () => {
            if (!isSubscribed) {
                return;
            }
            isSubscribed = false;
            off();
            this.handleEntityListenerRemoved(entity, listeners);
        };
    }

    /** Replaces the rooms this socket receives events for; sent in `hello` and live. */
    setRooms(roomIds) {
        const newRooms = [...roomIds];
        const isUnchanged = areSameList(newRooms, this.rooms) && !this.areRoomsReleased;
        this.rooms = newRooms;
        this.areRoomsReleased = false;

        // Before `ready` the list travels in `hello` (see handleReady for a change after it).
        if (isUnchanged || !this.isSocketReady) {
            return;
        }
        this.sendRooms(this.rooms);
    }

    /** listener({ seq }) after every `ready` and `rooms-ok`: the moment to refetch. */
    onReady(listener) {
        return this.readyListeners.add(listener);
    }

    /** listener() when the server can't replay missed events; without listeners the page reloads. */
    onResync(listener) {
        return this.resyncListeners.add(listener);
    }

    /** listener(status) whenever the status changes. */
    onStatus(listener) {
        return this.statusListeners.add(listener);
    }

    /** @returns {RealtimeStatus} */
    getStatus() {
        return this.status;
    }

    /** listener(presenceMessage) for every `presence` message. */
    onPresence(listener) {
        return this.presenceListeners.add(listener);
    }

    /** listener(message) for every `vote`, `vote-passed` and `vote-error` message. */
    onVote(listener) {
        return this.voteListeners.add(listener);
    }

    voteHold(roomId, topic, option) {
        this.send({ type: CLIENT_MESSAGE.VOTE_HOLD, room_id: roomId, topic, option });
    }

    voteRelease(roomId, topic) {
        this.send({ type: CLIENT_MESSAGE.VOTE_RELEASE, room_id: roomId, topic });
    }

    /** listener(message) for every `entry-status` message. */
    onEntryStatus(listener) {
        return this.entryStatusListeners.add(listener);
    }

    /** Tells the room I am entering cards for `round`; `state` is 'scanning', 'typing' or null when done. */
    entryStatus(roomId, state, round) {
        this.send({ type: CLIENT_MESSAGE.ENTRY_STATUS, room_id: roomId, state, round });
    }

    // --- Entity listeners ------------------------------------------------------

    handleEntityListenerRemoved(entity, listeners) {
        const isCurrentSet = this.listenersByEntity.get(entity) === listeners;
        if (isCurrentSet && listeners.size === 0) {
            this.listenersByEntity.delete(entity);
        }

        if (!this.hasListeners()) {
            this.scheduleIdleClose();
        }
    }

    /** Only entity subscriptions keep the socket open; the other listeners ride along. */
    hasListeners() {
        return this.listenersByEntity.size > 0;
    }

    // --- Status ----------------------------------------------------------------

    setStatus(status) {
        if (status === this.status) {
            return;
        }
        this.status = status;
        this.statusListeners.emit(status);
    }

    /** The status to show while a new socket is being opened. */
    pendingStatus() {
        if (this.hasBeenLive) {
            return 'reconnecting';
        }
        return 'connecting';
    }

    // --- Socket lifecycle ------------------------------------------------------

    /** @param {boolean} [isFreshSubscribe]  the first subscriber after none were left */
    start(isFreshSubscribe = false)  {
        this.attachLifecycleListeners();

        // Signed out: a wake event, a reload or a fresh first subscribe retries, not an
        // additional subscriber. A fresh subscribe still goes through failure counting
        // and the auth check.
        if (this.status === 'signed-out' && !isFreshSubscribe) {
            return;
        }

        const isConnectingOrWaiting = this.socket !== null || this.reconnectTimer !== null;
        if (!isConnectingOrWaiting) {
            this.connect();
        }
    }

    connect() {
        this.clearReconnectTimer();
        // An older auth check's answer says nothing about the socket opened now.
        this.authCheckGeneration += 1;
        this.setStatus(this.pendingStatus());

        let socket;
        try {
            socket = new this.WebSocketImpl(this.url);
        } catch (error) {
            console.error('[realtime] Could not open socket:', error);
            this.retryAfterFailure();
            return;
        }

        this.socket = socket;
        this.isSocketReady = false;
        this.connectStartedAt = Date.now();
        this.connectTimer = setTimeout(() => this.handleConnectTimeout(socket), CONNECT_TIMEOUT_MS);

        socket.onopen = () => this.handleOpen(socket);
        socket.onmessage = (event) => this.handleMessage(socket, event.data);
        socket.onclose = () => this.handleClose(socket);
        // A close event always follows an error, so reconnecting is left to onclose.
        socket.onerror = () => {};
    }

    handleOpen(socket) {
        if (socket !== this.socket) {
            return;
        }

        this.clearConnectTimer();
        this.areRoomsReleased = false;
        this.helloRooms = [...this.rooms];
        this.send({ type: CLIENT_MESSAGE.HELLO, epoch: this.epoch, last_seq: this.lastSeq, rooms: this.helloRooms });
        this.startPing();
    }

    handleConnectTimeout(socket) {
        this.connectTimer = null;
        if (socket !== this.socket) {
            return;
        }

        this.dropSocket();
        this.retryAfterFailure();
    }

    handleClose(socket) {
        if (socket !== this.socket) {
            return;
        }

        const wasReady = this.isSocketReady;
        const wasStable = this.stableTimer === null;
        this.detachSocket();

        if (!this.hasListeners()) {
            this.closeIdle();
            return;
        }

        // A socket lost soon after `ready` counts as a failed connect.
        if (wasReady && wasStable) {
            this.setStatus(this.pendingStatus());
            this.scheduleReconnect();
        } else {
            this.retryAfterFailure();
        }
    }

    /** A connect attempt (or a fresh socket) failed: back off, and now and then check the login. */
    retryAfterFailure() {
        this.recordFailure();
        this.setStatus(this.pendingStatus());
        this.scheduleReconnect();
    }

    /** Counts one failed connect and checks the login on every third. */
    recordFailure() {
        this.failedConnects += 1;

        const isAuthCheckDue = this.failedConnects % AUTH_CHECK_EVERY_FAILURES === 0;
        if (isAuthCheckDue) {
            this.checkSignedIn();
        }
    }

    scheduleReconnect() {
        if (this.reconnectTimer !== null) {
            return;
        }

        const delay = reconnectDelay(this.reconnectAttempts);
        this.reconnectAttempts += 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    clearReconnectTimer() {
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    clearStableTimer() {
        if (this.stableTimer !== null) {
            clearTimeout(this.stableTimer);
            this.stableTimer = null;
        }
    }

    clearConnectTimer() {
        if (this.connectTimer !== null) {
            clearTimeout(this.connectTimer);
            this.connectTimer = null;
        }
    }

    /** Forgets the current socket and its timers, without closing it. */
    detachSocket() {
        const socket = this.socket;
        if (!socket) {
            return null;
        }

        this.socket = null;
        this.isSocketReady = false;
        this.clearConnectTimer();
        this.clearStableTimer();
        this.stopPing();
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        return socket;
    }

    /** Abandons the current socket without waiting for its close event. */
    dropSocket() {
        const socket = this.detachSocket();
        if (!socket) {
            return;
        }

        try {
            socket.close();
        } catch {
            // Already closing or never opened; nothing to clean up.
        }
    }

    reconnectNow() {
        this.dropSocket();
        this.connect();
    }

    isSocketOpen() {
        return this.socket !== null && this.socket.readyState === OPEN;
    }

    send(message) {
        if (this.isSocketOpen()) {
            this.socket.send(JSON.stringify(message));
        }
    }

    sendRooms(rooms) {
        this.send({ type: CLIENT_MESSAGE.ROOMS, rooms });
    }

    // --- Signed-out check --------------------------------------------------------

    /**
     * Asks the server whether the session is still valid. A 401 or an opaque redirect
     * means signed out; any other answer, or a network error, means keep retrying.
     */
    async checkSignedIn() {
        if (!this.fetchImpl) {
            return;
        }

        this.authCheckGeneration += 1;
        const generation = this.authCheckGeneration;

        let isSignedOut = false;
        try {
            const response = await this.fetchImpl(AUTH_CHECK_PATH, {
                credentials: 'same-origin',
                redirect: 'manual',
                headers: { Accept: 'application/json' },
            });
            isSignedOut = isSignedOutResponse(response);
        } catch {
            // Offline or unreachable: that says nothing about the session.
        }

        // A `ready`, an idle close or a newer check since then makes this answer stale.
        const isStale = generation !== this.authCheckGeneration;
        if (isSignedOut && !isStale) {
            this.signOut();
        }
    }

    signOut() {
        this.clearReconnectTimer();
        this.dropSocket();
        this.setStatus('signed-out');
    }

    // --- Incoming messages -------------------------------------------------------

    handleMessage(socket, raw) {
        if (socket !== this.socket) {
            return;
        }

        const message = parseMessage(raw);
        if (!message) {
            return;
        }

        if (VOTE_MESSAGE_TYPES.has(message.type)) {
            this.voteListeners.emit(message);
            return;
        }

        switch (message.type) {
            case SERVER_MESSAGE.READY:
                this.handleReady(message);
                break;
            case SERVER_MESSAGE.ROOMS_OK:
                this.handleRoomsOk(message);
                break;
            case SERVER_MESSAGE.EVENT:
                this.handleEvent(message);
                break;
            case SERVER_MESSAGE.RESYNC:
                this.handleResync();
                break;
            case SERVER_MESSAGE.PONG:
                this.clearPongTimer();
                break;
            case SERVER_MESSAGE.PRESENCE:
                this.presenceListeners.emit(message);
                break;
            case SERVER_MESSAGE.ENTRY_STATUS:
                this.entryStatusListeners.emit(message);
                break;
            default:
                break;
        }
    }

    handleReady(message) {
        this.epoch = message.epoch;
        this.lastSeq = message.seq;
        this.isSocketReady = true;
        this.hasBeenLive = true;
        this.authCheckGeneration += 1;
        this.clearStableTimer();
        this.stableTimer = setTimeout(() => this.handleStable(), STABLE_READY_MS);
        this.setStatus('live');

        // setRooms may have changed the list after `hello` went out.
        if (!areSameList(this.rooms, this.helloRooms)) {
            this.sendRooms(this.rooms);
        }
        this.readyListeners.emit({ seq: message.seq });
    }

    /** The socket stayed ready long enough to call the connection healthy. */
    handleStable() {
        this.stableTimer = null;
        this.reconnectAttempts = 0;
        this.failedConnects = 0;
    }

    handleRoomsOk(message) {
        // Events up to `seq` for the rooms we already had were delivered before this reply,
        // so `seq` can never move the stream position back.
        const isAhead = this.lastSeq === null || message.seq > this.lastSeq;
        if (isAhead) {
            this.lastSeq = message.seq;
        }

        // Nothing to refetch for an empty or released list (pagehide), and a reply can't
        // come before the first `ready`.
        const hasRooms = this.rooms.length > 0 && !this.areRoomsReleased;
        if (hasRooms && this.isSocketReady) {
            this.readyListeners.emit({ seq: message.seq });
        }
    }

    handleEvent(message) {
        const isDuplicate = this.lastSeq !== null && message.seq <= this.lastSeq;
        if (isDuplicate) {
            return;
        }

        this.lastSeq = message.seq;
        const meta = { room_version: message.room_version ?? null, seq: message.seq };
        this.dispatch(message.entity, message.event, meta);
    }

    handleResync() {
        // With no epoch yet we have never seen any events, so nothing can be stale.
        // Guards against a server that answers a first-time `hello { epoch: null }` with resync.
        if (this.epoch === null) {
            return;
        }

        // Last resort: no page knows how to refetch, so start fresh.
        if (this.resyncListeners.size === 0) {
            this.reload();
            return;
        }
        this.resyncListeners.emit();
    }

    dispatch(entity, event, meta) {
        const listeners = this.listenersByEntity.get(entity);
        if (listeners) {
            listeners.emit(event, meta);
        }
    }

    // --- Keepalive -----------------------------------------------------------------

    startPing() {
        this.stopPing();
        this.pingTimer = setInterval(() => this.pingIfVisible(), PING_INTERVAL_MS);
    }

    stopPing() {
        if (this.pingTimer !== null) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
        this.clearPongTimer();
    }

    clearPongTimer() {
        if (this.pongTimer !== null) {
            clearTimeout(this.pongTimer);
            this.pongTimer = null;
        }
    }

    isPageVisible() {
        const documentTarget = this.environment.document;
        if (!documentTarget) {
            return true;
        }
        return documentTarget.visibilityState !== 'hidden';
    }

    pingIfVisible() {
        if (this.isPageVisible()) {
            this.rejoinReleasedRooms();
            this.ping();
        }
    }

    /** A cancelled navigation fires `pagehide` without unloading: rejoin once visible again. */
    rejoinReleasedRooms() {
        if (this.areRoomsReleased && this.isSocketOpen()) {
            this.areRoomsReleased = false;
            this.sendRooms(this.rooms);
        }
    }

    /** Sends a ping and replaces the socket if no pong follows in time. */
    ping() {
        // One ping in flight is enough; its timer already decides the socket's fate.
        if (!this.isSocketOpen() || this.pongTimer !== null) {
            return;
        }

        this.send({ type: CLIENT_MESSAGE.PING });
        this.pongTimer = setTimeout(() => {
            this.pongTimer = null;
            // Reconnect first: opening a socket invalidates auth checks already in flight.
            this.reconnectNow();
            this.recordFailure();
        }, PONG_TIMEOUT_MS);
    }

    // --- Wake-up and page lifecycle ------------------------------------------------

    attachLifecycleListeners() {
        if (this.isLifecycleAttached) {
            return;
        }
        this.isLifecycleAttached = true;

        const { window: windowTarget, document: documentTarget, navigator: navigatorTarget } = this.environment;
        const wake = () => this.handleWake();

        if (windowTarget) {
            windowTarget.addEventListener('online', wake);
            windowTarget.addEventListener('pageshow', /** @param {PageTransitionEvent} event */ (event) => {
                // Restored from the back/forward cache; a normal load needs no wake-up.
                if (event.persisted) {
                    wake();
                }
            });
            windowTarget.addEventListener('pagehide', () => this.releaseRooms());
        }

        if (documentTarget) {
            documentTarget.addEventListener('visibilitychange', () => {
                if (documentTarget.visibilityState === 'visible') {
                    wake();
                }
            });
            // Chrome's page lifecycle: fired when a frozen page is resumed.
            documentTarget.addEventListener('resume', wake);
        }

        // Network Information API (Android Chrome): fires on a Wi-Fi <-> mobile data switch,
        // which leaves the old socket half-open without any `online` event.
        const networkConnection = navigatorTarget?.connection;
        if (networkConnection && typeof networkConnection.addEventListener === 'function') {
            networkConnection.addEventListener('change', wake);
        }
    }

    /** Tells the server we've left our rooms so presence shows us offline straight away. */
    releaseRooms() {
        if (!this.isSocketOpen()) {
            return;
        }
        this.sendRooms([]);
        this.areRoomsReleased = true;
    }

    /** The page may have slept or the network changed: make sure the socket is alive now. */
    handleWake() {
        if (!this.hasListeners()) {
            return;
        }

        if (this.isSocketOpen()) {
            // Back from the bfcache with the socket still open: rejoin our rooms.
            if (this.areRoomsReleased) {
                this.areRoomsReleased = false;
                this.sendRooms(this.rooms);
            }
            this.ping();
            return;
        }

        // The connect timer may not have fired while the page was hidden, so check here too.
        const isConnecting = this.socket !== null && this.socket.readyState === CONNECTING;
        const isConnectRecent = Date.now() - this.connectStartedAt < CONNECT_TIMEOUT_MS;
        if (isConnecting && isConnectRecent) {
            return;
        }

        // Waiting out a backoff delay, stuck connecting, or signed out: start over now
        // with short delays.
        this.reconnectAttempts = 0;
        this.failedConnects = 0;
        this.authCheckGeneration += 1;
        this.dropSocket();
        this.connect();
    }

    // --- Idle close ------------------------------------------------------------------

    scheduleIdleClose() {
        this.cancelIdleClose();
        this.idleTimer = setTimeout(() => this.closeIdle(), IDLE_CLOSE_DELAY_MS);
    }

    cancelIdleClose() {
        if (this.idleTimer !== null) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    /**
     * Closes the socket once nobody listens. The stream position is forgotten too:
     * with no listeners there is no state to keep in sync, and resuming from an old
     * position later would only trigger a needless resync.
     */
    closeIdle() {
        this.cancelIdleClose();
        if (this.hasListeners()) {
            return;
        }

        this.dropSocket();
        this.clearReconnectTimer();
        this.epoch = null;
        this.lastSeq = null;
        this.reconnectAttempts = 0;
        this.failedConnects = 0;
        this.authCheckGeneration += 1;
        this.hasBeenLive = false;

        // Signed-out sticks until a wake event or a reload, even across an idle close.
        if (this.status !== 'signed-out') {
            this.setStatus('connecting');
        }
    }
}
