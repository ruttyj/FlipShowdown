import { SERVER_MESSAGE } from '../../../shared/realtimeProtocol.js';

// Entity events: numbering and storing them in the durable event log, sending each to the sockets
// allowed to receive it, and replaying the stored ones to a client that reconnects. The log's
// epoch and seq are the position a client resumes from (see docs/backend-contract.md).

/** A GameRoom belongs to itself; everything else to its room_id. Null when neither. */
function eventRoomId(entity, record) {
    const roomId = entity === 'GameRoom' ? record.id : record.room_id;
    if (typeof roomId !== 'string' || roomId === '') {
        return null;
    }
    return roomId;
}

function buildEventText(seq, entity, type, record, roomVersion) {
    return JSON.stringify({
        type: SERVER_MESSAGE.EVENT,
        seq,
        entity,
        event: { type, id: record.id, data: record, timestamp: new Date().toISOString() },
        room_version: roomVersion ?? null,
    });
}

export class EventPublisher {
    #eventLog;
    #connections;
    #subscriptions;
    #lifecycle;

    /**
     * `eventLog` is the store's event log (EventRepository: epoch, lastSeq, oldestSeq, appendAll,
     * readAfter). `connections` is the ConnectionManager (clients, send), `subscriptions` the
     * SubscriptionManager, which decides who may receive an event, and `lifecycle` the hub's
     * Lifecycle, whose guard each send runs under.
     */
    constructor({ eventLog, connections, subscriptions, lifecycle }) {
        this.#eventLog = eventLog;
        this.#connections = connections;
        this.#subscriptions = subscriptions;
        this.#lifecycle = lifecycle;
    }

    /** The event log's id; a client holding another epoch has to resync. */
    get epoch() {
        return this.#eventLog.epoch;
    }

    /** The seq of the newest event stored. */
    get seq() {
        return this.#eventLog.lastSeq;
    }

    // --- Publishing --------------------------------------------------------------

    /**
     * Stores entity changes in the event log, all in one transaction, and sends each to the
     * sockets allowed to receive it. `events` is [{ entity, type, record }]; `roomVersion` is the
     * room's version after the action that produced them (null for generic entity writes).
     * Throws only when storing fails, and then sends nothing; a failed send is logged and the
     * remaining events still go out. Returns [{ roomId, entity }] for the events, in order.
     */
    publishAll(events, { roomVersion } = {}) {
        const entries = [];
        for (const event of events) {
            entries.push({
                roomId: eventRoomId(event.entity, event.record),
                entity: event.entity,
                buildText: (seq) => buildEventText(seq, event.entity, event.type, event.record, roomVersion),
            });
        }
        const stored = this.#eventLog.appendAll(entries);

        for (const [index, entry] of entries.entries()) {
            this.#lifecycle.runGuarded(`${entry.entity} event`, () => {
                this.#sendEvent(entry.roomId, entry.entity, stored[index].text);
            });
        }

        return entries.map((entry) => ({ roomId: entry.roomId, entity: entry.entity }));
    }

    #sendEvent(roomId, entity, text) {
        for (const socket of this.#connections.clients) {
            if (this.#subscriptions.canReceive(socket, roomId, entity)) {
                this.#connections.send(socket, text);
            }
        }
    }

    // --- Hello -------------------------------------------------------------------

    /**
     * Decides how to answer a hello from a client at `epoch` / `lastSeq`:
     *   'fresh'  - client has no position (first connect), nothing to replay
     *   'replay' - same epoch and every event after lastSeq is still stored
     *   'resync' - the event log was lost, or the client is too far behind / ahead
     */
    classifyHello(epoch, lastSeq) {
        const hasPosition = typeof epoch === 'string' && epoch !== '';
        if (!hasPosition) {
            return 'fresh';
        }
        if (epoch !== this.#eventLog.epoch) {
            return 'resync';
        }
        if (!Number.isInteger(lastSeq)) {
            return 'fresh';
        }

        const oldestStoredSeq = this.#eventLog.oldestSeq() ?? this.#eventLog.lastSeq + 1;
        const isAheadOfServer = lastSeq > this.#eventLog.lastSeq;
        // Replay needs the event right after lastSeq to still be stored.
        const isGapTooOld = lastSeq + 1 < oldestStoredSeq;
        if (isAheadOfServer || isGapTooOld) {
            return 'resync';
        }
        return 'replay';
    }

    /** Sends the socket every stored event after `lastSeq` that it may receive, oldest first. */
    replay(socket, lastSeq) {
        // null reads every room's events; canReceive below still filters what a "*" socket gets.
        let roomIds = null;
        if (!this.#subscriptions.watchesAllRooms(socket)) {
            roomIds = [...this.#subscriptions.roomsOf(socket)];
        }
        for (const row of this.#eventLog.readAfter(lastSeq, roomIds)) {
            if (this.#subscriptions.canReceive(socket, row.room_id, row.entity)) {
                this.#connections.send(socket, row.text);
            }
        }
    }
}
