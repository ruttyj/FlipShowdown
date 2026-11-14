import { RealtimeHub } from '../realtime/RealtimeHub.js';
import { BaseProvider } from './BaseProvider.js';

// The realtime hub: its managers, the WebSocket endpoint and the hold-to-vote topics. Building it
// starts the connection timers; HttpProvider attaches it to the HTTP server. Shutting down stops
// its callbacks, timers and sockets before the HTTP server closes.

export class RealtimeProvider extends BaseProvider {
    register(app) {
        app.register('hub', () => {
            const config = app.get('config');
            const authenticator = app.get('authenticator');
            return new RealtimeHub({
                authenticate: (headers) => authenticator.authenticate(headers),
                store: app.get('store'),
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
