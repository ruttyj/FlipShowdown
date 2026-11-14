// The client socket message handlers by message type (D2): each is { type, handle(socket, message) }
// (see realtime/handlers/). RealtimeServer looks a parsed message's `type` up here.

export class SocketHandlerRegistry {
    // A Map, so a type like "toString" or "__proto__" is never found on a prototype, and a type
    // that isn't a string (an array, say) is never coerced to one that is.
    #handlers = new Map();

    /** Registers each of `handlers` under its `type`. */
    constructor(handlers = []) {
        for (const handler of handlers) {
            this.add(handler);
        }
    }

    /** Registers `handler` under its `type`. Throws if the type is taken, so one can't hide another. */
    add(handler) {
        if (this.#handlers.has(handler.type)) {
            throw new Error(`Socket handler already registered: ${handler.type}`);
        }
        this.#handlers.set(handler.type, handler);
    }

    /** The handler for message type `type`, or null when there is none. */
    get(type) {
        return this.#handlers.get(type) ?? null;
    }
}
