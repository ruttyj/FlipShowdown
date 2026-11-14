import http from 'node:http';
import express from 'express';
import { createAuthApiRouter, createLoginRouter, createRequireUser } from '../http/authRoutes.js';
import { createEntitiesRouter } from '../http/entities.js';
import { apiNotFound, createErrorHandler } from '../http/errorHandler.js';
import { createRoomsRouter } from '../http/roomsRoutes.js';
import { mountStaticFrontend } from '../http/staticFrontend.js';
import { BaseProvider } from './BaseProvider.js';

// The Express app, its routers in the order the contract needs, and the http.Server the realtime
// hub attaches to. Shutting down stops accepting connections and lets in-flight requests finish.

const JSON_BODY_LIMIT = '1mb';
const CLOSE_GRACE_MS = 5000;

/**
 * The route modules' shared context: { config, store, authenticator, logger, hub, entities }.
 * The entities router reaches the hub through it at call time (tests replace hub methods).
 */
function createRouteContext(app) {
    const config = app.get('config');
    return {
        config,
        store: app.get('store'),
        authenticator: app.get('authenticator'),
        logger: app.get('logger'),
        hub: app.get('hub'),
        entities: config.entities,
    };
}

/** The game actions as the rooms router takes them: { runner, registry, createRoom, lookupByCode }. */
function createRoomActions(app) {
    return {
        runner: app.get('roomActionRunner'),
        registry: app.get('actionRegistry'),
        createRoom: app.get('createRoomAction'),
        lookupByCode: app.get('lookupByCodeAction'),
    };
}

/** The Express app with every route, the static frontend and the error handler, in order. */
function createExpressApp(app) {
    const config = app.get('config');
    const logger = app.get('logger');
    const context = createRouteContext(app);
    const expressApp = express();
    expressApp.set('trust proxy', config.trustProxy);
    expressApp.disable('x-powered-by');

    expressApp.get('/api/health', (req, res) => {
        res.json({ ok: true });
    });
    // Before the global JSON parser: the scan route parses its own, larger photo bodies.
    expressApp.use('/api/ai', createRequireUser(context), app.get('aiRouter'));
    expressApp.use('/api', express.json({ limit: JSON_BODY_LIMIT }));
    expressApp.use('/api/auth', createAuthApiRouter(context));
    expressApp.use('/api/entities', createRequireUser(context), createEntitiesRouter(context));
    expressApp.use('/api/rooms', createRequireUser(context), createRoomsRouter(createRoomActions(app)));
    // Unknown /api paths still require auth first, as the contract says.
    expressApp.use('/api', createRequireUser(context), apiNotFound);

    expressApp.use(createLoginRouter(context));
    mountStaticFrontend(expressApp, config.staticDir, logger);
    expressApp.use(createErrorHandler(logger));
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
        app.register('expressApp', () => {
            return createExpressApp(app);
        });
        app.register('httpServer', () => {
            return http.createServer(app.get('expressApp'));
        });
    }

    boot(app) {
        app.get('hub').attach(app.get('httpServer'));
    }

    shutdown(app) {
        return closeHttpServer(app.get('httpServer'));
    }
}
