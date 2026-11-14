import { createAuthenticator } from '../services/auth.js';
import { BaseProvider } from './BaseProvider.js';

// The request authenticator for the configured AUTH_MODE, shared by HTTP and the WebSocket
// upgrade. The `keySet` option replaces the remote Cloudflare JWKS (tests).

export class AuthProvider extends BaseProvider {
    register(app) {
        app.register('authenticator', () => {
            return createAuthenticator(app.get('config'), {
                keySet: app.options.keySet,
                logger: app.get('logger'),
            });
        });
    }
}
