// Whether the realtime hub is still running, and the guard every socket, timer and tracker callback
// runs under. One instance is shared by the realtime managers, so closing the hub stops all of their
// late callbacks at once.

export class Lifecycle {
    /** `logger` is a console-like object; a guarded handler's throw goes to its `error`. */
    constructor({ logger }) {
        this.logger = logger;
        this.isClosed = false;
    }

    /**
     * Runs a socket, timer or tracker handler, logging a throw instead of crashing the process.
     * Does nothing once closed, so a late callback can't touch a closed hub.
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

    /** Guarded handlers are skipped from now on. */
    close() {
        this.isClosed = true;
    }
}
