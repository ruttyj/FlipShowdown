// The server's clock. The realtime managers share one, so a test drives liveness, vote countdowns
// and entry status windows with a single fake `now`.

export class Clock {
    /** `now()` returns the current time in ms; tests pass a fake one. */
    constructor(now = Date.now) {
        this.readNow = now;
    }

    /** The current time in ms. */
    now() {
        return this.readNow();
    }
}
