import crypto from 'node:crypto';

// The fields every stored record has, whichever table it lives in. Shared by the typed-table
// repositories and the generic `records` code in database/db.js.

/** Fields the server owns; whatever the client sends for these is discarded. */
export const SERVER_MANAGED_FIELDS = ['id', 'created_date', 'updated_date', 'created_by'];

/** 24 lowercase hex chars (Mongo-style ids). */
export function generateId() {
    return crypto.randomBytes(12).toString('hex');
}

/** The current time as an ISO string, the format of every stored date. */
export function currentTimestamp() {
    return new Date().toISOString();
}

/** Returns a copy of client input without the server-managed fields. */
export function stripServerFields(input) {
    // Spread defines own properties, so a "__proto__" key stays plain data.
    const clean = { ...input };
    for (const field of SERVER_MANAGED_FIELDS) {
        delete clean[field];
    }
    return clean;
}
