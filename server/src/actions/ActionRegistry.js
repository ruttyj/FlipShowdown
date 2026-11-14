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

    /** Every registered name, in the order they were added. */
    names() {
        return [...this.#handlers.keys()];
    }
}
