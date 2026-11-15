import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

// The built client (STATIC_DIR): hashed assets cached for a year, everything else revalidated,
// the third-party notices at /licenses and index.html for client-side routes. Not a routed
// Controller: express.static and the SPA fallback go on the app itself, after every other route.

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;
const NOTICES_FILE = 'THIRD_PARTY_NOTICES.txt';

// --- Helpers -------------------------------------------------------------

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

// --- Controller ----------------------------------------------------------

export class StaticController {
    /** `staticDir` is the STATIC_DIR setting; `logger` gets the warning when it has no index.html. */
    constructor({ staticDir, logger }) {
        this.staticDir = staticDir;
        this.logger = logger;
    }

    /** Serves the client on the Express `app`, or logs a warning when STATIC_DIR has no index.html. */
    routes(app) {
        const indexPath = path.join(this.staticDir, 'index.html');
        if (!fs.existsSync(indexPath)) {
            this.logger.warn(`STATIC_DIR ${this.staticDir} has no index.html; not serving the frontend`);
            return;
        }

        app.use(express.static(this.staticDir, {
            index: false,
            setHeaders: createStaticCacheHeaders(this.staticDir),
        }));
        app.get('/licenses', (req, res, next) => this.sendLicenses(req, res, next));
        app.use((req, res, next) => this.sendIndex(req, res, next));
    }

    /** The client build's third-party notices (scripts/third-party-notices.mjs), as plain text. */
    sendLicenses(req, res, next) {
        if (!fs.existsSync(path.join(this.staticDir, NOTICES_FILE))) {
            next();
            return;
        }
        res.type('text/plain; charset=utf-8');
        res.sendFile(NOTICES_FILE, { root: this.staticDir });
    }

    /** index.html for a client-side route; anything else goes on (to a 404). */
    sendIndex(req, res, next) {
        if (!isSpaRoute(req)) {
            next();
            return;
        }
        res.setHeader('Cache-Control', 'no-cache');
        // send ignores dotfiles in the full path unless it is given a root, so a
        // STATIC_DIR such as .worktrees/x/dist would otherwise 500.
        res.sendFile('index.html', { root: this.staticDir });
    }
}
