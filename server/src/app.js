import { App } from './providers/App.js';
import { createProviders } from './providers/index.js';

/**
 * Builds the server through the App container (providers/) without listening. Options:
 *   keySet - JWKS replacement for Cloudflare verification (tests)
 *   logger - console-like object (defaults to console)
 *   geminiFetch - fetch replacement for Gemini API calls (tests)
 *   now - clock for AI caches and rate limits (tests; defaults to Date.now)
 *   realtimeNow - clock for realtime presence liveness (tests; defaults to Date.now)
 *   eventLogLimit - how many realtime events to keep (tests; defaults to 5000)
 *   voteHoldMs - how long a hold-to-vote must be held (tests; defaults to 3000)
 *   launcherPort - where room stats go (tests; defaults to Electron's process.parentPort,
 *     absent outside the desktop launcher)
 *   launcherReportDelayMs - how long room stats changes are coalesced (tests; defaults to 1000)
 *   roomSweepNow - clock for the stale-room sweep (tests; defaults to Date.now)
 * Returns { app, server, store, hub, sweepStaleRooms, close }, where `app` is the Express app.
 */
export function createServer(config, options = {}) {
    const container = new App(config, options);
    for (const provider of createProviders()) {
        container.addProvider(provider);
    }
    container.start();

    return {
        app: container.get('expressApp'),
        server: container.get('httpServer'),
        store: container.get('store'),
        hub: container.get('hub'),
        /** Runs the stale-room sweep now; returns the deleted room ids. */
        sweepStaleRooms: () => container.get('roomSweeper').sweep(),
        /**
         * Stops the sweep, the launcher reporter and the hub, stops accepting connections, lets
         * in-flight requests finish (up to 5 s), then closes the DB.
         */
        close: () => container.close(),
    };
}
