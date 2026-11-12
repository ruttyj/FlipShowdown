// `npm run dev`: runs the API server (server/, restarted on changes to server/src and shared) and the
// Vite dev server together, so one command is enough for local development. Ctrl+C, or
// either process exiting, stops both.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ROOT = path.join(PROJECT_ROOT, 'server');

const children = [];

// --- Helpers ------------------------------------------------------------------

function installServerDependencies() {
    if (fs.existsSync(path.join(SERVER_ROOT, 'node_modules', 'express'))) {
        return;
    }

    console.log('Installing server dependencies...');
    const result = spawnSync('npm ci --no-audit --no-fund', { cwd: SERVER_ROOT, stdio: 'inherit', shell: true });
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

// shell: true lets Windows resolve npx.cmd; the command is a single string because passing
// an args array alongside shell: true is deprecated.
function start(command, cwd) {
    const child = spawn(command, { cwd, stdio: 'inherit', shell: true });
    child.on('exit', (code) => stopAll(code ?? 0));
    children.push(child);
}

// child.kill() would only end the shell on Windows, leaving node running and holding the
// port, so kill the whole process tree there.
function stopChild(child) {
    if (child.exitCode !== null) {
        return;
    }

    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
        child.kill('SIGTERM');
    }
}

let stopping = false;

function stopAll(exitCode) {
    if (stopping) {
        return;
    }
    stopping = true;

    for (const child of children) {
        stopChild(child);
    }
    process.exit(exitCode);
}

// --- Main ---------------------------------------------------------------------

installServerDependencies();
start('npx nodemon --quiet --watch src --watch ../shared src/index.js', SERVER_ROOT);
// Extra arguments go to Vite, e.g. `npm run dev -- --port 7100`.
const viteArgs = process.argv.slice(2).join(' ');
start(`npx vite ${viteArgs}`, PROJECT_ROOT);

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
