import { EventRepository } from '../repositories/EventRepository.js';
import { Database } from './Database.js';

// The realtime event log now lives in repositories/EventRepository.js, and the store's `eventLog`
// is that repository. This adapter keeps the old entry point for the tests that build a log on a
// raw connection; production code must not call it.

/**
 * An EventRepository over an open better-sqlite3 connection. `maxEvents` is how many of the
 * newest events are kept (default 5000); it must be an integer >= 1.
 */
export function createEventLog(connection, { maxEvents } = {}) {
    return new EventRepository(new Database(connection), { maxEvents });
}
