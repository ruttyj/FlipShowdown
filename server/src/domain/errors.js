// Error types shared across the server. Imports nothing.

// --- Store errors ------------------------------------------------------------

/**
 * A write the database refused, or a value of the wrong type. `status` is 400 (`invalid_record`)
 * or 409 (`conflict`); the routes answer with `toBody()`.
 */
export class StoreError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }

    toBody() {
        return { message: this.message, code: this.code };
    }
}

// --- Action errors -----------------------------------------------------------

/**
 * An expected failure. Thrown inside an action body it rolls the
 * transaction back and becomes `status` + `{ message, code, ...extra }`.
 */
export class ActionError extends Error {
    constructor(status, code, message, extra = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.extra = extra;
    }

    toBody() {
        return { message: this.message, code: this.code, ...this.extra };
    }
}

export function badRequest(message) {
    return new ActionError(400, 'bad_request', message);
}
