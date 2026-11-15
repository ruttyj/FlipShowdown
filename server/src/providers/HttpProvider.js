import http from 'node:http';
import express from 'express';
import { AuthController } from '../http/controllers/AuthController.js';
import { EntitiesController } from '../http/controllers/EntitiesController.js';
import { RoomsController } from '../http/controllers/RoomsController.js';
import { StaticController } from '../http/controllers/StaticController.js';
import { apiNotFound } from '../http/middleware/apiNotFound.js';
import { createErrorHandler } from '../http/middleware/errorHandler.js';
import { createRequireUser } from '../http/middleware/requireUser.js';
import { EntityService } from '../services/EntityService.js';
import { UserService } from '../services/UserService.js';
import { BaseProvider } from './BaseProvider.js';

// The Express app: the services and controllers behind it, the middleware and routers in the order
// the contract needs, and the http.Server the realtime hub attaches to. Shutting down stops
// accepting connections and lets in-flight requests finish.

const JSON_BODY_LIMIT = '1mb';
const CLOSE_GRACE_MS = 5000;

/** The Express app with every route, the static frontend and the error handler, in order. */
function createExpressApp(app) {
    const requireUser = app.get('requireUser');
    const authController = app.get('authController');
    const expressApp = express();
    expressApp.set('trust proxy', app.get('config').trustProxy);
    expressApp.disable('x-powered-by');

    expressApp.get('/api/health', (req, res) => {
        res.json({ ok: true });
    });
    // Before the global JSON parser: the scan route parses its own, larger photo bodies. Unlike the
    // other controllers' routers, this one is built by AiProvider (registered as 'aiRouter', a name
    // the provider tests pin) so all the AI wiring stays in that provider.
    expressApp.use('/api/ai', requireUser, app.get('aiRouter'));
    expressApp.use('/api', express.json({ limit: JSON_BODY_LIMIT }));
    expressApp.use('/api/auth', authController.router());
    expressApp.use('/api/entities', requireUser, app.get('entitiesController').router());
    expressApp.use('/api/rooms', requireUser, app.get('roomsController').router());
    // Unknown /api paths still require auth first, as the contract says.
    expressApp.use('/api', requireUser, apiNotFound);

    expressApp.use(authController.loginRouter());
    expressApp.use(app.get('staticController').router());
    expressApp.use(createErrorHandler(app.get('logger')));
    return expressApp;
}

/** Stops accepting connections, lets in-flight requests finish (up to CLOSE_GRACE_MS), then resolves. */
function closeHttpServer(server) {
    return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
        const forceTimer = setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS);
        forceTimer.unref();
    });
}

export class HttpProvider extends BaseProvider {
    register(app) {
        this.registerServices(app);
        this.registerControllers(app);
        app.register('expressApp', () => {
            return createExpressApp(app);
        });
        app.register('httpServer', () => {
            return http.createServer(app.get('expressApp'));
        });
    }

    /** The services the controllers call, and the auth middleware. */
    registerServices(app) {
        app.register('userService', () => {
            const config = app.get('config');
            return new UserService({
                userRepository: app.get('repositories').users,
                adminEmails: config.adminEmails,
                sessionSecret: config.sessionSecret,
            });
        });
        app.register('entityService', () => {
            const config = app.get('config');
            const repositories = app.get('repositories');
            return new EntityService({
                entityGateway: app.get('entityGateway'),
                roomRepository: repositories.rooms,
                playerRepository: repositories.players,
                // Only for create, whose store.createRecords call coverageGaps.test replaces.
                store: app.get('store'),
                // The hub object itself, whose methods the service looks up when it publishes.
                hub: app.get('hub'),
                entityNames: config.entities,
                lockGameEntities: config.lockGameEntities,
                adminEmails: config.adminEmails,
            });
        });
        app.register('requireUser', () => {
            return createRequireUser({
                authenticator: app.get('authenticator'),
                users: app.get('userService'),
            });
        });
    }

    registerControllers(app) {
        app.register('authController', () => {
            return new AuthController({
                users: app.get('userService'),
                authenticator: app.get('authenticator'),
                requireUser: app.get('requireUser'),
                authMode: app.get('config').authMode,
            });
        });
        app.register('entitiesController', () => {
            return new EntitiesController({ entities: app.get('entityService') });
        });
        app.register('roomsController', () => {
            return new RoomsController({
                runner: app.get('roomActionRunner'),
                registry: app.get('actionRegistry'),
                createRoom: app.get('createRoomAction'),
                lookupByCode: app.get('lookupByCodeAction'),
            });
        });
        app.register('staticController', () => {
            const config = app.get('config');
            return new StaticController({ staticDir: config.staticDir, logger: app.get('logger') });
        });
    }

    boot(app) {
        app.get('hub').attach(app.get('httpServer'));
    }

    shutdown(app) {
        return closeHttpServer(app.get('httpServer'));
    }
}
