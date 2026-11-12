// Playwright global setup: builds the frontend into dist/ once per run and stages a copy
// for the servers to serve (their STATIC_DIR, as in the Docker image).
//
// An existing dist/index.html is reused to keep reruns fast, unless a file in src/ or shared/ is newer
// than it. Set E2E_REBUILD=1 to force a fresh build.
//
// Why a copy: the server's SPA fallback uses res.sendFile(), which refuses any path with a
// dot segment, so a checkout under ".worktrees/" (or any dotted folder) would answer every
// page load with a 500. The copy lives in the OS temp folder and is deleted after the run.
// Its path reaches the workers through process.env.E2E_STATIC_DIR (see server.js).
//
// Wired up in playwright.config.js as `globalSetup`; nothing to call from a spec.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DIST_DIR, REPO_ROOT, SHARED_DIR, SRC_DIR } from './paths.js';

/** Newest modification time (ms) of any file under `directory`. */
function newestModifiedTime(directory) {
    let newest = 0;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        const modifiedTime = entry.isDirectory()
            ? newestModifiedTime(entryPath)
            : fs.statSync(entryPath).mtimeMs;
        newest = Math.max(newest, modifiedTime);
    }
    return newest;
}

function shouldBuild() {
    if (process.env.E2E_REBUILD === '1') {
        return true;
    }

    const builtIndex = path.join(DIST_DIR, 'index.html');
    if (!fs.existsSync(builtIndex)) {
        return true;
    }

    const newestSource = Math.max(newestModifiedTime(SRC_DIR), newestModifiedTime(SHARED_DIR));
    return newestSource > fs.statSync(builtIndex).mtimeMs;
}

function buildFrontend() {
    // shell: true lets Windows find npm.cmd.
    const result = spawnSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit', shell: true });
    if (result.status !== 0) {
        throw new Error(`Frontend build failed (exit code ${result.status})`);
    }
}

function stageStaticCopy() {
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-e2e-dist-'));
    fs.cpSync(DIST_DIR, stagingDir, { recursive: true });
    return stagingDir;
}

/** Returns the global teardown, which deletes the staged copy. */
export default function globalSetup() {
    if (shouldBuild()) {
        buildFrontend();
    }

    const stagingDir = stageStaticCopy();
    process.env.E2E_STATIC_DIR = stagingDir;

    return () => {
        fs.rmSync(stagingDir, { recursive: true, force: true });
    };
}
