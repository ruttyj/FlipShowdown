// Stages what the launcher runs from source into desktop/build:
//   build/server  server/src plus production node_modules, better-sqlite3 rebuilt for Electron
//   build/shared  the rule kernel, which server/src imports as ../../shared
//   build/dist    the built client (run `npm run build` at the root first)
//
// A copy, not links: a utility process given the repo's live server/ resolves better-sqlite3
// from server/node_modules, which must stay on the system Node ABI for the server tests. Only
// the staged copy is rebuilt for Electron.
//
// Usage: node scripts/stage.mjs   (from desktop/, or `npm run stage`)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { rebuild } from '@electron/rebuild';

const require = createRequire(import.meta.url);
const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '..');
const BUILD_ROOT = path.join(DESKTOP_ROOT, 'build');

const SOURCE = {
    server: path.join(REPO_ROOT, 'server'),
    shared: path.join(REPO_ROOT, 'shared'),
    dist: path.join(REPO_ROOT, 'dist'),
};
const STAGED = {
    server: path.join(BUILD_ROOT, 'server'),
    shared: path.join(BUILD_ROOT, 'shared'),
    dist: path.join(BUILD_ROOT, 'dist'),
};

/** Replaces `target` with a fresh copy of `source`. */
function copyFresh(source, target) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(source, target, { recursive: true });
}

function copyServerSources() {
    fs.rmSync(STAGED.server, { recursive: true, force: true });
    fs.mkdirSync(STAGED.server, { recursive: true });
    for (const file of ['package.json', 'package-lock.json']) {
        fs.copyFileSync(path.join(SOURCE.server, file), path.join(STAGED.server, file));
    }
    fs.cpSync(path.join(SOURCE.server, 'src'), path.join(STAGED.server, 'src'), { recursive: true });
}

function installProductionDependencies() {
    // shell: true because npm is a .cmd shim on Windows.
    execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd: STAGED.server,
        stdio: 'inherit',
        shell: true,
    });
}

/**
 * The engine electron-builder's install-app-deps uses. better-sqlite3 downloads its matching
 * electron-v<abi> prebuild, and compiles only when none exists (which needs a C++ toolchain).
 * @param {string} electronVersion
 */
async function rebuildForElectron(electronVersion) {
    await rebuild({
        buildPath: STAGED.server,
        electronVersion,
        arch: process.arch,
        onlyModules: ['better-sqlite3'],
        force: true,
    });
}

function copyBuiltClient() {
    if (!fs.existsSync(SOURCE.dist)) {
        throw new Error('No dist/ at the repo root. Run `npm run build` there first.');
    }
    copyFresh(SOURCE.dist, STAGED.dist);
}

async function main() {
    const electronVersion = require('electron/package.json').version;

    copyBuiltClient();
    copyServerSources();
    copyFresh(SOURCE.shared, STAGED.shared);
    installProductionDependencies();
    await rebuildForElectron(electronVersion);
    console.log(`Staged the server and client for Electron ${electronVersion} in ${BUILD_ROOT}`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
