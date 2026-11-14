// The game actions by name, as handlers RoomActionRunner can run: each is
// { access, allowedStatuses, handle(work, body) } (see RoomActionRunner#run).

export class ActionRegistry {
    // A Map, so a name like "toString" or "__proto__" is never found on a prototype.
    #handlers = new Map();

    /** Registers `handler` under `name`. Throws if the name is taken, so one can't hide another. */
    add(name, handler) {
        if (this.#handlers.has(name)) {
            throw new Error(`Action already registered: ${name}`);
        }
        this.#handlers.set(name, handler);
    }

    /** The handler registered under `name`, or null when there is none. */
    get(name) {
        return this.#handlers.get(name) ?? null;
    }

    /**
     * The handler registered under `name`. Throws when there is none, so wiring that needs a
     * handler fails when the server is built, not at the first request that uses it.
     */
    require(name) {
        const handler = this.get(name);
        if (!handler) {
            throw new Error(`Action not registered: ${name}`);
        }
        return handler;
    }
}
