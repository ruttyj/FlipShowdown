// Runs the real Flip7 server (server/src/index.js) for one test.
//
// Each test gets its own server on a free port, with AUTH_MODE=dev, a fresh temporary
// DATA_DIR and STATIC_DIR pointing at the built frontend (staged by build-frontend.js).
// The server is stopped and the temp dir deleted after the test.
//
// Usage (import `test` and `expect` from here instead of @playwright/test):
//
//     import { test, expect } from './fixtures/server.js';
//
//     test('something', async ({ page, server }) => {
//         await page.goto('/');                 // baseURL is the test's server
//         await server.restart();               // same port and DATA_DIR, so data and
//                                               // session cookies survive
//         await server.stop();                  // e.g. to test "server down"
//         await server.start();
//     });
//
// `server` is { url, port, dataDir, start(), stop(), restart(), output() }; output() returns
// what the server has printed so far, handy in failure messages.
// startServer() is exported for tests that need a second, independent server.
//
// Extra server environment: ADMIN_EMAILS is blanked for every server, so a developer's shell
// can't make anyone an admin. A spec that needs more sets the `serverEnv` option, which is
// scoped to that spec file (or describe block) and never touches process.env:
//
//     test.use({ serverEnv: { ADMIN_EMAILS: 'boss@e2e.test', DEV_ALLOW_ADMINS: 'true' } });
//
// (The e2e servers run AUTH_MODE=dev, which ignores ADMIN_EMAILS without DEV_ALLOW_ADMINS, X89.)
//
// startServer({ env: { ... } }) takes the same overrides for a second server.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { test as base, expect } from '@playwright/test';

import { DIST_DIR, REPO_ROOT, SERVER_ENTRY } from './paths.js';

// The staged copy from build-frontend.js; dist/ itself when that setup didn't run.
const STATIC_DIR = process.env.E2E_STATIC_DIR || DIST_DIR;

const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 100;
const STOP_TIMEOUT_MS = 5_000;

// --- Helpers -------------------------------------------------------------

/** Asks the OS for a free port. The fixed port lets a restarted server keep its URL. */
function findFreePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.unref();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

function buildServerEnv(port, dataDir, extraEnv) {
    return {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dataDir,
        STATIC_DIR,
        AUTH_MODE: 'dev',
        // Unset so a developer's shell can't switch on AI scanning or fix the secret.
        GEMINI_API_KEY: '',
        SESSION_SECRET: '',
        ADMIN_EMAILS: '',
        ...extraEnv,
    };
}

async function isHealthy(url) {
    try {
        const response = await fetch(`${url}/api/health`);
        return response.ok;
    } catch {
        return false;
    }
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True once this test's own process has printed its "listening on port N" line. Health alone
 * isn't proof: another process holding the port would answer it too.
 */
function hasAnnouncedPort(processState, port) {
    return processState.output.includes(`listening on port ${port}`);
}

/**
 * Resolves once our own server announced its port and /api/health answers; throws if the
 * process exits or the wait times out.
 */
async function waitUntilReady(url, port, processState) {
    const deadline = Date.now() + READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
        if (processState.exited) {
            throw new Error(`Server exited during startup:\n${processState.output}`);
        }
        if (hasAnnouncedPort(processState, port) && (await isHealthy(url))) {
            return;
        }
        await delay(READY_POLL_MS);
    }

    throw new Error(`Server did not become ready within ${READY_TIMEOUT_MS} ms:\n${processState.output}`);
}

function spawnServer(port, dataDir, extraEnv) {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
        cwd: REPO_ROOT,
        env: buildServerEnv(port, dataDir, extraEnv),
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const processState = { child, output: '', exited: false };
    const collectOutput = (chunk) => {
        processState.output += chunk.toString();
    };
    child.stdout.on('data', collectOutput);
    child.stderr.on('data', collectOutput);
    child.on('exit', () => {
        processState.exited = true;
    });

    return processState;
}

/** Kills the process and waits for it to exit (a hard kill on Windows, SIGTERM elsewhere). */
async function killServer(processState) {
    if (processState.exited) {
        return;
    }

    const exited = new Promise((resolve) => processState.child.once('exit', resolve));
    processState.child.kill();

    const timedOut = delay(STOP_TIMEOUT_MS).then(() => 'timeout');
    const outcome = await Promise.race([exited, timedOut]);
    if (outcome === 'timeout') {
        processState.child.kill('SIGKILL');
        await exited;
    }
}

// --- Server handle -------------------------------------------------------

/**
 * Starts a server on a free port with a new temporary DATA_DIR and returns its handle
 * (see the header comment), plus dispose() which stops it and deletes the DATA_DIR.
 * `env` overrides or adds server environment variables, on every start and restart.
 */
export async function startServer({ env = {} } = {}) {
    const port = await findFreePort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-e2e-'));
    const url = `http://127.0.0.1:${port}`;
    let processState = null;
    let previousOutput = '';

    const handle = {
        url,
        port,
        dataDir,
        async start() {
            if (processState && !processState.exited) {
                throw new Error('Server is already running');
            }
            if (processState) {
                previousOutput += processState.output;
            }
            processState = spawnServer(port, dataDir, env);
            await waitUntilReady(url, port, processState);
        },
        async stop() {
            if (processState) {
                await killServer(processState);
            }
        },
        async restart() {
            await handle.stop();
            await handle.start();
        },
        output() {
            const currentOutput = processState ? processState.output : '';
            return previousOutput + currentOutput;
        },
        async dispose() {
            await handle.stop();
            // SQLite can hold the file briefly after the process exits on Windows.
            fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        },
    };

    try {
        await handle.start();
    } catch (error) {
        await handle.dispose();
        throw error;
    }
    return handle;
}

// --- Fixtures ------------------------------------------------------------

export const test = base.extend({
    // Extra environment for this test's server; set with test.use({ serverEnv: {...} }).
    serverEnv: [{}, { option: true }],
    server: async ({ serverEnv }, use) => {
        const server = await startServer({ env: serverEnv });
        await use(server);
        await server.dispose();
    },
    // page.goto('/') and newPlayer() go to this test's server.
    baseURL: async ({ server }, use) => {
        await use(server.url);
    },
});

export { expect };
