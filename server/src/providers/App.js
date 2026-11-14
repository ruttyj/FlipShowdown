// The server's container. Each provider registers its parts by name, then every provider boots
// (attaches listeners, starts timers) once all parts are registered, and close() shuts the
// providers down in reverse order. Parts are built lazily, on their first get(), so a provider
// can ask for a part another provider registers later in the list.
//
// This file lives in providers/ rather than next to app.js: on a case-insensitive file system
// (Windows, the default macOS volume) "App.js" and "app.js" are the same file.

export class App {
    #providers = [];
    // name -> { factory, isBuilt, isBuilding, instance }
    #parts = new Map();

    /**
     * `config` is loadConfig()'s result and `options` createServer's options (test overrides such
     * as clocks, a fake key set or a fake launcher port). Only providers read them.
     */
    constructor(config, options = {}) {
        this.config = config;
        this.options = options;
    }

    /** Adds a provider; providers register and boot in the order they were added. */
    addProvider(provider) {
        this.#providers.push(provider);
    }

    /**
     * Registers a part. `factory(app)` builds it on the first get(name); later gets return the
     * same instance. Throws when the name is already registered.
     */
    register(name, factory) {
        if (this.#parts.has(name)) {
            throw new Error(`Already registered: ${name}`);
        }
        this.#parts.set(name, { factory, isBuilt: false, isBuilding: false, instance: undefined });
    }

    /**
     * The part registered as `name`, built on first use. Throws when nothing is registered under
     * that name, or when building it asks for itself again (a dependency cycle).
     */
    get(name) {
        const part = this.#parts.get(name);
        if (!part) {
            throw new Error(`Nothing registered as ${name}`);
        }
        if (part.isBuilt) {
            return part.instance;
        }
        if (part.isBuilding) {
            throw new Error(`Dependency cycle while building ${name}`);
        }

        part.isBuilding = true;
        try {
            part.instance = part.factory(this);
        } finally {
            part.isBuilding = false;
        }
        part.isBuilt = true;
        return part.instance;
    }

    /** Lets every provider register its parts, then boots them all, in the order added. */
    start() {
        for (const provider of this.#providers) {
            provider.register(this);
        }
        for (const provider of this.#providers) {
            provider.boot(this);
        }
    }

    /** Shuts the providers down in reverse order, each finishing before the next starts. */
    async close() {
        const reversed = [...this.#providers].reverse();
        for (const provider of reversed) {
            await provider.shutdown(this);
        }
    }
}
