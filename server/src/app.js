import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { createAiRouter } from './aiRoutes.js';
import { createAuthenticator } from './auth.js';
import { createAuthApiRouter, createLoginRouter, createRequireUser } from './authRoutes.js';
import { openStore } from './db.js';
import { createEntitiesRouter } from './entities.js';
import { createRoomsRouter } from './gameActions/index.js';
import { createVoteTopics } from './gameActions/voteTopics.js';
import { createLauncherReporter } from './launcherReporter.js';
import { createRealtimeHub } from './realtime.js';
import { createStaleRoomSweeper } from './staleRooms.js';

const JSON_BODY_LIMIT = '1mb';
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;
const CLOSE_GRACE_MS = 5000;
const NOTICES_FILE = 'THIRD_PARTY_NOTICES.txt';

// --- Static frontend -----------------------------------------------------

function createStaticCacheHeaders(staticDir) {
    const assetsDir = path.join(staticDir, 'assets') + path.sep;

    return function setStaticCacheHeaders(res, filePath) {
        if (filePath.startsWith(assetsDir)) {
            // Vite puts content hashes in these file names, so they never change.
            res.setHeader('Cache-Control', `public, max-age=${ONE_YEAR_SECONDS}, immutable`);
        } else {
            res.setHeader('Cache-Control', 'no-cache');
        }
    };
}

/** Requests that should get index.html so client-side routing can handle them. */
function isSpaRoute(req) {
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    const isApi = req.path === '/api' || req.path.startsWith('/api/');
    // A missing hashed asset should 404, not return HTML that the browser tries to run.
    const isAsset = req.path.startsWith('/assets/');
    return isRead && !isApi && !isAsset && req.path !== '/login';
}

function mountStaticFrontend(app, staticDir, logger) {
    const indexPath = path.join(staticDir, 'index.html');
    if (!fs.existsSync(indexPath)) {
        logger.warn(`STATIC_DIR ${staticDir} has no index.html; not serving the frontend`);
        return;
    }

    app.use(express.static(staticDir, { index: false, setHeaders: createStaticCacheHeaders(staticDir) }));
    // The client build's third-party notices (scripts/third-party-notices.mjs), as plain text.
    app.get('/licenses', (req, res, next) => {
        if (!fs.existsSync(path.join(staticDir, NOTICES_FILE))) {
            next();
            return;
        }
        res.type('text/plain; charset=utf-8');
        res.sendFile(NOTICES_FILE, { root: staticDir });
    });
    app.use((req, res, next) => {
        if (!isSpaRoute(req)) {
            next();
            return;
        }
        res.setHeader('Cache-Control', 'no-cache');
        // send ignores dotfiles in the full path unless it is given a root, so a
        // STATIC_DIR such as .worktrees/x/dist would otherwise 500.
        res.sendFile('index.html', { root: staticDir });
    });
}

// --- Error handling ------------------------------------------------------

function apiNotFound(req, res) {
    res.status(404).json({ message: 'Not found' });
}

function createErrorHandler(logger) {
    // Express recognises error handlers by their four parameters.
    // eslint-disable-next-line no-unused-vars
    return function handleError(error, req, res, next) {
        if (error.type === 'entity.parse.failed') {
            res.status(400).json({ message: 'Invalid JSON body' });
            return;
        }
        if (error.type === 'entity.too.large') {
            res.status(413).json({ message: 'Request body too large' });
            return;
        }

        logger.error(`Unhandled error on ${req.method} ${req.originalUrl}`, error);
        if (res.headersSent) {
            res.end();
            return;
        }
        res.status(500).json({ message: 'Internal server error' });
    };
}

// --- Assembly ------------------------------------------------------------

/**
 * Builds the Express app, HTTP server, store and realtime hub without
 * listening. Options:
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
 * Returns { app, server, store, hub, sweepStaleRooms, close }.
 */
export function createServer(config, options = {}) {
    const logger = options.logger || console;
    const store = openStore(config.dataDir, { eventLogLimit: options.eventLogLimit });
    const authenticator = createAuthenticator(config, { keySet: options.keySet, logger });
    // The vote topics run game actions, which publish through the hub, so the
    // hub joins the context once it exists.
    const context = { config, store, authenticator, logger, hub: null, entities: config.entities };
    const hub = createRealtimeHub({
        authenticate: (headers) => authenticator.authenticate(headers),
        store,
        isAdmin: (identity) => config.adminEmails.has(identity.email),
        logger,
        now: options.realtimeNow,
        voteTopics: createVoteTopics(context),
        voteHoldMs: options.voteHoldMs,
        hostOfflineGraceMs: config.hostOfflineGraceMs ?? undefined,
        onStatsChanged: () => reporter.markChanged(),
    });
    context.hub = hub;
    const reporter = createLauncherReporter({
        // undefined means Electron's process.parentPort; tests pass a fake or null.
        parentPort: options.launcherPort,
        buildStats: () => hub.buildRoomStats(),
        delayMs: options.launcherReportDelayMs,
        logger,
    });

    const app = express();
    app.set('trust proxy', config.trustProxy);
    app.disable('x-powered-by');

    app.get('/api/health', (req, res) => {
        res.json({ ok: true });
    });
    // Before the global JSON parser: the scan route parses its own, larger photo bodies.
    app.use(
        '/api/ai',
        createRequireUser(context),
        createAiRouter({ config, logger, fetchImpl: options.geminiFetch, now: options.now }),
    );
    app.use('/api', express.json({ limit: JSON_BODY_LIMIT }));
    app.use('/api/auth', createAuthApiRouter(context));
    app.use('/api/entities', createRequireUser(context), createEntitiesRouter(context));
    app.use('/api/rooms', createRequireUser(context), createRoomsRouter(context));
    // Unknown /api paths still require auth first, as the contract says.
    app.use('/api', createRequireUser(context), apiNotFound);

    app.use(createLoginRouter(context));
    mountStaticFrontend(app, config.staticDir, logger);
    app.use(createErrorHandler(logger));

    const server = http.createServer(app);
    hub.attach(server);
    // The launcher shows 0 / 0 as soon as the server is up, not after the first change (X66).
    server.on('listening', () => reporter.sendNow());
    const sweeper = createStaleRoomSweeper({
        context,
        maxIdleMs: config.staleRoomMaxIdleMs,
        now: options.roomSweepNow,
    });
    server.on('listening', () => sweeper.start());

    return {
        app,
        server,
        store,
        hub,
        /** Runs the stale-room sweep now; returns the deleted room ids. */
        sweepStaleRooms: () => sweeper.sweep(),
        /** Stops accepting connections, lets in-flight requests finish (up to 5 s), closes the DB. */
        close() {
            sweeper.stop();
            reporter.close();
            hub.close();
            return new Promise((resolve) => {
                server.close(() => {
                    store.close();
                    resolve();
                });
                server.closeIdleConnections();
                const forceTimer = setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS);
                forceTimer.unref();
            });
        },
    };
}
