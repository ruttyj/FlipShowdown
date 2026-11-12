// `npm run share`: makes sure a Gemini API key is configured, starts the dev server (hot
// reload) plus a Cloudflare quick tunnel, prints a QR code for the public URL so phones
// can join, and opens that URL in the browser. Ctrl+C stops the tunnel; `npm run stop` stops
// everything.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = path.join(PROJECT_ROOT, '.env');
const TUNNEL_TIMEOUT_MS = 60_000;
// Gives the new hostname's DNS record a moment to propagate before the browser looks it up.
const BROWSER_OPEN_DELAY_MS = 3_000;

const GEMINI_KEY_NAME = 'GEMINI_API_KEY';
const GEMINI_KEY_PAGE = 'https://aistudio.google.com/apikey';
const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// The service terms the link relies on (X69); the launcher's Home tab says the same.
const TUNNEL_NOTICE = "Your game link uses a free Cloudflare Quick Tunnel. It's meant for casual use, has no uptime guarantee, and Cloudflare's terms apply.";

// Matches the URL cloudflared prints, e.g. "|  https://calm-river-1234.trycloudflare.com  |".
const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
// Logged once the tunnel can carry traffic; before that the URL answers with errors.
const TUNNEL_READY_PATTERN = /Registered tunnel connection/;

// --- Shell helpers ---------------------------------------------------------

function dockerCompose(args, { quiet = false } = {}) {
    const result = spawnSync('docker', ['compose', ...args], {
        cwd: PROJECT_ROOT,
        stdio: quiet ? 'pipe' : 'inherit',
        encoding: 'utf8',
    });
    if (result.status !== 0) {
        const output = quiet ? `\n${result.stderr}` : '';
        throw new Error(`docker compose ${args.join(' ')} failed${output}`);
    }
    return result.stdout;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Opens `url` in the default browser without waiting for it. */
function openInBrowser(url) {
    let command = 'xdg-open';
    let args = [url];
    if (process.platform === 'win32') {
        // `start` is a cmd builtin; the empty string is its window-title argument.
        command = 'cmd';
        args = ['/c', 'start', '""', url];
    } else if (process.platform === 'darwin') {
        command = 'open';
    }

    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => console.log(`Could not open a browser; visit ${url} manually.`));
    child.unref();
}

// --- .env file -----------------------------------------------------------------

/** Creates .env from .env.example on first run, with a fresh session secret. */
function ensureEnvFile() {
    if (fs.existsSync(ENV_PATH)) {
        return;
    }

    const template = fs.readFileSync(path.join(PROJECT_ROOT, '.env.example'), 'utf8');
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(ENV_PATH, template.replace(/^SESSION_SECRET=$/m, `SESSION_SECRET=${secret}`));
    console.log('Created .env from .env.example');
}

function envLinePattern(name) {
    return new RegExp(`^${name}=(.*)$`, 'm');
}

/** Value of `name` in .env, or '' when the line is missing or empty. */
function readEnvValue(name) {
    const match = fs.readFileSync(ENV_PATH, 'utf8').match(envLinePattern(name));
    if (!match) {
        return '';
    }
    return match[1].trim();
}

/** Replaces the `name=` line in .env, or appends one when it's missing. */
function writeEnvValue(name, value) {
    const text = fs.readFileSync(ENV_PATH, 'utf8');
    const line = `${name}=${value}`;
    const pattern = envLinePattern(name);

    if (pattern.test(text)) {
        // A function replacement, so "$" in the value isn't treated as a capture reference.
        fs.writeFileSync(ENV_PATH, text.replace(pattern, () => line));
        return;
    }

    const separator = text === '' || text.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(ENV_PATH, `${text}${separator}${line}\n`);
}

// --- Gemini API key ----------------------------------------------------------

/**
 * Asks Google whether the key works by listing models.
 * Returns 'valid', 'invalid', or 'unknown' (network trouble, so we can't tell).
 */
async function checkGeminiKey(key) {
    try {
        const response = await fetch(GEMINI_MODELS_URL, { headers: { 'x-goog-api-key': key } });
        if (response.ok) {
            return 'valid';
        }
        if (response.status === 400 || response.status === 401 || response.status === 403) {
            return 'invalid';
        }
        return 'unknown';
    } catch {
        return 'unknown';
    }
}

function printGeminiKeyInstructions() {
    console.log('');
    console.log('No Gemini API key found in .env. It powers the AI card scanning.');
    console.log(`  1. Open ${GEMINI_KEY_PAGE} and sign in with a Google account.`);
    console.log('  2. Click "Create API key" and copy it.');
    console.log('  3. Paste it below. It is saved to .env and only used by the server.');
    console.log('Press Enter without a key to skip; players can still enter scores manually.');
    console.log('');
}

/** Prompts until a usable key is entered or the user skips. Returns the key or ''. */
async function promptForGeminiKey() {
    const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });

    try {
        while (true) {
            const key = (await prompt.question('Gemini API key: ')).trim();
            if (key === '') {
                return '';
            }

            const status = await checkGeminiKey(key);
            if (status === 'valid') {
                console.log('Key works.');
                return key;
            }
            if (status === 'unknown') {
                console.log('Could not reach Google to check the key; saving it anyway.');
                return key;
            }
            console.log('Google rejected that key. Check it was copied completely and try again.');
        }
    } finally {
        prompt.close();
    }
}

async function ensureGeminiKey() {
    if (readEnvValue(GEMINI_KEY_NAME) !== '') {
        console.log('Using the Gemini API key from .env');
        return;
    }

    printGeminiKeyInstructions();
    const key = await promptForGeminiKey();
    if (key === '') {
        console.log('Skipped. AI card scanning stays off until a key is added to .env.');
        return;
    }

    writeEnvValue(GEMINI_KEY_NAME, key);
    console.log(`Saved ${GEMINI_KEY_NAME} to .env`);
}

// --- Containers --------------------------------------------------------------

function startDevServer() {
    console.log('\nStarting the dev server (the first run installs dependencies and takes a few minutes)...');
    // The production container uses the same host port.
    dockerCompose(['stop', 'app'], { quiet: true });
    // Recreate so it picks up .env changes such as a newly entered key.
    dockerCompose(['--profile', 'share', 'up', '-d', '--build', '--force-recreate', '--wait', 'dev']);
}

function startTunnel() {
    console.log('Starting the Cloudflare quick tunnel...');
    console.log(TUNNEL_NOTICE);
    // Recreate so the logs only contain this run's URL.
    dockerCompose(['--profile', 'share', 'up', '-d', '--force-recreate', '--no-deps', 'quicktunnel']);
}

function stopTunnel() {
    dockerCompose(['--profile', 'share', 'rm', '--stop', '--force', 'quicktunnel'], { quiet: true });
}

/**
 * Polls the tunnel's logs until it has printed its URL and registered a connection.
 * Deliberately doesn't probe the URL itself: looking up a brand-new hostname before its
 * DNS record exists can get the failure cached by the OS resolver for minutes.
 */
async function waitForTunnelUrl() {
    const deadline = Date.now() + TUNNEL_TIMEOUT_MS;

    while (Date.now() < deadline) {
        const logs = dockerCompose(['--profile', 'share', 'logs', '--no-color', 'quicktunnel'], { quiet: true });
        const urlMatch = logs.match(TUNNEL_URL_PATTERN);
        const isReady = TUNNEL_READY_PATTERN.test(logs);
        if (urlMatch && isReady) {
            return urlMatch[0];
        }
        await sleep(1000);
    }

    throw new Error('Timed out waiting for the tunnel. Check: docker compose --profile share logs quicktunnel');
}

async function printShareInfo(url) {
    console.log('');
    console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
    console.log(`Public URL: ${url}`);
    console.log(`Local URL:  http://localhost:${readEnvValue('HOST_PORT') || '7007'}`);
    console.log('');
    console.log('Scan the QR code with a phone camera. Host from the public URL (not localhost) so');
    console.log('room invite QR codes point at it. Code changes reload on every connected phone.');
    console.log('A new URL is issued each run; if it does not load yet, give DNS a few seconds.');
}

// --- Main --------------------------------------------------------------------

function waitForCtrlC() {
    // Signal listeners don't keep Node alive; without this timer the process exits at once
    // and the tunnel cleanup in main's `finally` never runs.
    const keepAlive = setInterval(() => {}, 60_000);

    return new Promise((resolve) => {
        const stop = () => {
            clearInterval(keepAlive);
            resolve();
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
    });
}

async function main() {
    ensureEnvFile();
    await ensureGeminiKey();
    startDevServer();
    startTunnel();

    // Whether sharing ends with Ctrl+C or a startup error, don't leave the URL public.
    try {
        const url = await waitForTunnelUrl();
        await printShareInfo(url);
        await sleep(BROWSER_OPEN_DELAY_MS);
        openInBrowser(url);

        console.log('\nSharing. When you finish, press Ctrl+C and run `npm run stop`, or the URL may stay public.');
        await waitForCtrlC();
    } finally {
        console.log('\nStopping the tunnel (the dev server keeps running locally; `npm run stop` stops it)...');
        stopTunnel();
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
