// `npm run dist [-- <electron-builder args>]`: packages the launcher for the OS it runs on.
//   1. builds the client (root `npm run build`) and the launcher page (root `npm run build:launcher`)
//   2. stages the server, shared and client (scripts/stage.mjs, better-sqlite3 for Electron)
//   3. on macOS, makes the staged better-sqlite3 a universal (x64 + arm64) binary
//   4. fetches the pinned cloudflared for every arch the installer ships
//   5. runs electron-builder (desktop/electron-builder.yml) with the root package.json version
//
// Examples (from desktop/):
//   npm run dist -- --dir --win --x64      unpacked Windows build in out/win-unpacked, no installer
//   npm run dist -- --publish never        what the release workflow runs; it uploads out/ itself
//
// Run it through npm (`npm run dist`): the root builds use the npm that started it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rebuild } from '@electron/rebuild';

import { fetchCloudflared, fetchCloudflaredLicense } from '../../scripts/fetch-cloudflared.mjs';

const require = createRequire(import.meta.url);
const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '..');
const STAGED_SERVER = path.join(DESKTOP_ROOT, 'build', 'server');
const BETTER_SQLITE_BINARY = path.join(
    STAGED_SERVER,
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
);

// Which cloudflared builds each installer bundles. The Mac DMG is universal, so it carries both
// arches; the launcher picks `<platform>-<process.arch>` at runtime (src/main/binaries.js).
const CLOUDFLARED_TARGETS = {
    win32: ['win32-x64'],
    darwin: ['darwin-x64', 'darwin-arm64'],
    linux: ['linux-x64'],
};

// --- Inputs -----------------------------------------------------------------

/**
 * The app version. The root package.json is its single source; electron-builder gets it through
 * extraMetadata, so desktop/package.json keeps a placeholder version.
 * @param {string} repoRoot
 * @returns {string}
 */
export function readAppVersion(repoRoot) {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    if (typeof packageJson.version !== 'string' || packageJson.version === '') {
        throw new Error(`${repoRoot}/package.json has no version`);
    }
    return packageJson.version;
}

/**
 * @param {string} platform process.platform of the build machine
 * @returns {string[]} fetch-cloudflared targets, e.g. ['win32-x64']
 */
export function cloudflaredTargetsFor(platform) {
    if (!Object.hasOwn(CLOUDFLARED_TARGETS, platform)) {
        throw new Error(`Packaging on "${platform}" is not supported (win32, darwin or linux).`);
    }
    return CLOUDFLARED_TARGETS[platform];
}

/**
 * @param {string} arch 'arm64' or 'x64', the arch the staged server was built for
 * @returns {string} the Mac arch still missing from a universal build
 */
export function otherMacArch(arch) {
    if (arch === 'arm64') {
        return 'x64';
    }
    return 'arm64';
}

/**
 * @param {string} version
 * @param {string[]} passthrough arguments given after `--`
 * @returns {string[]}
 */
export function electronBuilderArgs(version, passthrough) {
    return [`-c.extraMetadata.version=${version}`, ...passthrough];
}

// --- Commands ---------------------------------------------------------------
// Every tool runs as `node <script>` without a shell, so arguments with spaces or shell
// characters reach it unchanged, and Windows needs no .cmd shims.

/**
 * @typedef {object} Command
 * @property {string} file  the executable, always this Node
 * @property {string[]} args
 */

/**
 * @param {string[]} args electron-builder arguments
 * @returns {Command}
 */
export function electronBuilderCommand(args) {
    return { file: process.execPath, args: [require.resolve('electron-builder/cli.js'), ...args] };
}

/**
 * @param {string} scriptName a root package.json script, e.g. 'build:launcher'
 * @param {string | undefined} npmExecPath process.env.npm_execpath: npm's own CLI script, set
 *   when dist runs through `npm run`
 * @returns {Command}
 */
export function npmScriptCommand(scriptName, npmExecPath) {
    if (!npmExecPath) {
        throw new Error(`Can't run "npm run ${scriptName}" without npm: start packaging with \`npm run dist\`.`);
    }
    return { file: process.execPath, args: [npmExecPath, 'run', scriptName] };
}

/**
 * The launcher page is built separately (root `npm run build:launcher`). electron-builder doesn't
 * fail on an empty `files` glob, and main.js would quietly show its placeholder page instead.
 * @param {string} desktopRoot
 */
export function assertRendererBuilt(desktopRoot) {
    const indexFile = path.join(desktopRoot, 'dist-renderer', 'index.html');
    if (!fs.existsSync(indexFile)) {
        throw new Error(`${indexFile} is missing: run \`npm run build:launcher\` at the repo root before packaging.`);
    }
}

/**
 * @param {Command} command
 * @param {string} cwd
 */
function run(command, cwd) {
    execFileSync(command.file, command.args, { cwd, stdio: 'inherit' });
}

// --- Steps ------------------------------------------------------------------

function buildClientAndLauncherPage() {
    run(npmScriptCommand('build', process.env.npm_execpath), REPO_ROOT);
    run(npmScriptCommand('build:launcher', process.env.npm_execpath), REPO_ROOT);
    assertRendererBuilt(DESKTOP_ROOT);
}

function stage() {
    execFileSync(process.execPath, [path.join(DESKTOP_ROOT, 'scripts', 'stage.mjs')], {
        cwd: DESKTOP_ROOT,
        stdio: 'inherit',
    });
}

/**
 * Staging rebuilt better-sqlite3 for the host arch only. electron-builder's universal build packs
 * an x64 and an arm64 app from the same staged folder and then merges them, so the binary has to
 * hold both arches already: rebuild it for the other arch and join the two with lipo. A binary
 * that is universal in both apps is left alone by the merge (@electron/universal).
 * @param {string} electronVersion
 */
async function makeBetterSqliteUniversal(electronVersion) {
    const hostCopy = `${BETTER_SQLITE_BINARY}.${process.arch}`;
    const universalOutput = `${BETTER_SQLITE_BINARY}.universal`;
    fs.copyFileSync(BETTER_SQLITE_BINARY, hostCopy);

    await rebuild({
        buildPath: STAGED_SERVER,
        electronVersion,
        arch: otherMacArch(process.arch),
        onlyModules: ['better-sqlite3'],
        force: true,
    });

    execFileSync('lipo', [hostCopy, BETTER_SQLITE_BINARY, '-create', '-output', universalOutput], {
        stdio: 'inherit',
    });
    fs.renameSync(universalOutput, BETTER_SQLITE_BINARY);
    fs.rmSync(hostCopy);
    execFileSync('lipo', ['-info', BETTER_SQLITE_BINARY], { stdio: 'inherit' });
}

async function fetchBundledCloudflared() {
    for (const target of cloudflaredTargetsFor(process.platform)) {
        const result = await fetchCloudflared(target);
        console.log(`cloudflared ${target}: ${result.status} -> ${result.path}`);
    }
    const license = await fetchCloudflaredLicense();
    console.log(`cloudflared LICENSE: ${license.status} -> ${license.path}`);
}

// --- Entry point ------------------------------------------------------------

async function main() {
    const version = readAppVersion(REPO_ROOT);
    const electronVersion = require('electron/package.json').version;

    buildClientAndLauncherPage();
    stage();
    if (process.platform === 'darwin') {
        await makeBetterSqliteUniversal(electronVersion);
    }
    await fetchBundledCloudflared();
    run(electronBuilderCommand(electronBuilderArgs(version, process.argv.slice(2))), DESKTOP_ROOT);
}

const isRunDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isRunDirectly) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
