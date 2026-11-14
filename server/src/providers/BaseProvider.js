// What every provider extends. A provider owns one area of the server: register() names its parts
// in the App, boot() runs once every provider has registered (listeners, timers) and shutdown()
// stops what boot started. App.close() calls shutdown in reverse provider order and awaits each.
// Each step does nothing unless the provider overrides it.

export class BaseProvider {
    /** Registers this area's parts with app.register(name, factory). */
    register(app) {}

    /** Wires this area once every part is registered. */
    boot(app) {}

    /** Stops this area; may return a promise. */
    shutdown(app) {}
}
