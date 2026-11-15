import { createStoreViews } from '../managers/storeViews.js';
import { RealtimeHub } from '../realtime/RealtimeHub.js';
import { BaseProvider } from './BaseProvider.js';

// The realtime hub: its managers and the WebSocket endpoint. It runs the hold-to-vote topics that
// GameProvider registers. Building it starts the connection timers; HttpProvider attaches it to
// the HTTP server. Shutting down stops its callbacks, timers and sockets before the HTTP server
// closes.

export class RealtimeProvider extends BaseProvider {
    register(app) {
        app.register('hub', () => {
            const config = app.get('config');
            const authenticator = app.get('authenticator');
            // Built on the store rather than the repositories: one of its reads goes through the
            // store facade, which entryStatus.test counts (see storeViews.js).
            const { rooms, players } = createStoreViews(app.get('store'));
            return new RealtimeHub({
                authenticate: (headers) => authenticator.authenticate(headers),
                eventLog: app.get('repositories').events,
                rooms,
                players,
                isAdmin: (identity) => config.adminEmails.has(identity.email),
                logger: app.get('logger'),
                clock: app.get('realtimeClock'),
                voteTopics: app.get('voteTopics'),
                voteHoldMs: app.options.voteHoldMs,
                hostOfflineGraceMs: config.hostOfflineGraceMs ?? undefined,
            });
        });
    }

    shutdown(app) {
        app.get('hub').close();
    }
}
