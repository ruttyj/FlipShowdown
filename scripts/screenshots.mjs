// `npm run screenshots`: regenerates the README's screenshots in docs/images/.
//
// The web app shots drive a real server (the e2e fixture: AUTH_MODE=dev, a temporary DATA_DIR)
// with three signed-in players in their own browser contexts. Card scanning is faked by
// answering /api/ai/* in the browser, so no Gemini key is needed. The launcher shots serve its
// built page and give it a fake window.launcher with made-up hosting data.
//
// Both frontends are rebuilt first (`npm run build`, `npm run build:launcher`).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

import { signIn } from '../e2e/fixtures/players.js';
import { startServer } from '../e2e/fixtures/server.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGES_DIR = path.join(REPO_ROOT, 'docs', 'images');
const LAUNCHER_DIST = path.join(REPO_ROOT, 'desktop', 'dist-renderer');
const SCAN_PHOTO = path.join(REPO_ROOT, 'server', 'test', 'fixtures', 'card-images', 'classic', 'zero_1_6_9_11_12_plus2.jpg');

// A phone-sized viewport at 2x, as the README shows them at 300px wide.
const PHONE = { width: 412, height: 915 };
// Tall enough that a whole score-entry panel fits without scrolling.
const TALL_PHONE = { width: 412, height: 2000 };
const LAUNCHER = { width: 420, height: 900 };
const SCALE = 2;

const HIGHLIGHT = '#f59e0b';
const FRAME_MARGIN = 6;

const TUNNEL_URL = 'https://brave-otter-lamp.trycloudflare.com';

// --- Helpers -------------------------------------------------------------

function run(command) {
    // shell: true lets Windows find npm.cmd.
    const result = spawnSync(command, { cwd: REPO_ROOT, stdio: 'inherit', shell: true });
    if (result.status !== 0) {
        throw new Error(`"${command}" failed (exit code ${result.status})`);
    }
}

function imagePath(name) {
    return path.join(IMAGES_DIR, `${name}.png`);
}

/**
 * Lets entry animations and fonts settle, drops focus and scrolls back to the top before a shot.
 * The game screens scroll inside Layout's div, not the window (docs/testing.md).
 */
async function settle(page) {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(800);
    await page.evaluate(() => {
        document.activeElement?.blur();
        window.scrollTo(0, 0);
        for (const element of document.querySelectorAll('*')) {
            if (element.scrollTop > 0) {
                element.scrollTop = 0;
            }
        }
    });
    await page.waitForTimeout(200);
}

/**
 * Grows the viewport until nothing scrolls, for a whole-page shot. The launcher scrolls inside
 * a container sized to the window, so a fullPage screenshot alone would cut it off.
 */
async function fitViewportToContent(page) {
    for (let attempt = 0; attempt < 5; attempt++) {
        const overflow = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('*')]
            .map((element) => element.scrollHeight - element.clientHeight)));
        if (overflow <= 0) {
            return;
        }
        const { width, height } = page.viewportSize();
        await page.setViewportSize({ width, height: height + overflow });
        await page.waitForTimeout(300);
    }
}

const AI_CONFIG = {
    enabled: true,
    default_model: 'gemini-3.5-flash-lite',
    models: [{ id: 'gemini-3.5-flash-lite', display_name: 'Gemini Flash Lite' }],
};

async function newPhone(browser, server, name, viewport = PHONE) {
    const context = await browser.newContext({
        baseURL: server.url,
        viewport,
        deviceScaleFactor: SCALE,
        isMobile: true,
        hasTouch: true,
        reducedMotion: 'reduce',
    });
    // Scanning shows as set up, without a Gemini key.
    await context.route('**/api/ai/config', (route) => route.fulfill({ json: AI_CONFIG }));
    const page = await context.newPage();
    await signIn(page, { name, email: `${name.toLowerCase()}@example.com` });
    return { context, page, name };
}

async function joinByCode(player, code) {
    await player.page.getByPlaceholder('Enter room code').fill(code);
    await player.page.getByRole('button', { name: 'Join room' }).click();
    await player.page.getByRole('button', { name: 'Leave Room' }).waitFor();
}

async function fillCards(page, values) {
    for (let index = 0; index < values.length; index++) {
        const position = index + 1;
        if (index > 0) {
            await page.getByRole('button', { name: 'Add card' }).click();
        }
        await page.getByLabel(`Card ${position} value`).fill(String(values[index]));
    }
}

async function submitScore(player, values) {
    await player.page.getByRole('button', { name: 'Enter Score Manually' }).click();
    await fillCards(player.page, values);
    await player.page.getByRole('button', { name: 'Confirm Score' }).click();
    await player.page.getByRole('button', { name: 'Confirm Score' }).waitFor({ state: 'hidden' });
}

/** Draws the orange ring the README uses to point at something, with a numbered badge if given. */
async function highlight(locator, badge = null) {
    await locator.evaluate((element, { color, label }) => {
        element.style.outline = `5px solid ${color}`;
        element.style.outlineOffset = '3px';
        element.style.position = 'relative';
        if (label) {
            const marker = document.createElement('span');
            marker.textContent = label;
            Object.assign(marker.style, {
                position: 'absolute', top: '-18px', left: '-6px', width: '28px', height: '28px',
                borderRadius: '999px', background: color, color: '#111827', font: '700 16px/28px system-ui',
                textAlign: 'center', zIndex: '50',
            });
            element.appendChild(marker);
        }
    }, { color: HIGHLIGHT, label: badge });
}

/** Shoots one element with the orange frame around it. */
async function shootFramed(page, locator, name) {
    await locator.evaluate((element, color) => {
        element.style.outline = `6px solid ${color}`;
        element.style.outlineOffset = '3px';
    }, HIGHLIGHT);
    await settle(page);
    const box = await locator.boundingBox();
    await page.screenshot({
        path: imagePath(name),
        clip: {
            x: box.x - FRAME_MARGIN - 3,
            y: box.y - FRAME_MARGIN - 3,
            width: box.width + 2 * (FRAME_MARGIN + 3),
            height: box.height + 2 * (FRAME_MARGIN + 3),
        },
    });
}

function entryPanel(page, title) {
    return page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

// --- Web app -------------------------------------------------------------

async function shootWebApp(browser) {
    const server = await startServer();
    try {
        const alex = await newPhone(browser, server, 'Alex');
        await settle(alex.page);
        await alex.page.screenshot({ path: imagePath('home') });

        await alex.page.getByRole('button', { name: 'Create Room' }).click();
        await alex.page.waitForURL(/\/room\//);
        const code = new URL(alex.page.url()).pathname.split('/').pop();

        const sam = await newPhone(browser, server, 'Sam');
        const jo = await newPhone(browser, server, 'Jo');
        await joinByCode(sam, code);
        await joinByCode(jo, code);
        await alex.page.getByText('3 joined').waitFor();
        await settle(alex.page);
        await alex.page.screenshot({ path: imagePath('lobby') });

        // Round 1, so the game room shows a scoreboard in round 2.
        await alex.page.getByRole('button', { name: 'Start Game' }).click();
        await submitScore(alex, [10, 12, 6]);
        await submitScore(jo, [12, 11, 4]);
        await submitScore(sam, [7, 8]);
        await alex.page.getByText('Round 2', { exact: true }).waitFor();

        await highlight(alex.page.getByRole('button', { name: 'Enter Score Manually' }), '1');
        await highlight(alex.page.getByRole('button', { name: 'Scan Cards' }), '2');
        await settle(alex.page);
        await alex.page.screenshot({ path: imagePath('game-room') });

        await shootManualEntry(browser, server, code);
        await shootScanner(browser, server, code);
    } finally {
        await server.dispose();
    }
}

async function shootManualEntry(browser, server, code) {
    const player = await newPhone(browser, server, 'Alex', TALL_PHONE);
    await player.page.goto(`/room/${code}`);
    await player.page.getByRole('button', { name: 'Enter Score Manually' }).click();
    await fillCards(player.page, [5, 10, 2]);
    await shootFramed(player.page, entryPanel(player.page, 'Enter Cards'), 'manual-entry');
    await player.context.close();
}

async function shootScanner(browser, server, code) {
    const player = await newPhone(browser, server, 'Alex', TALL_PHONE);
    await player.page.route('**/api/ai/scan-cards', (route) => route.fulfill({
        json: {
            model: 'gemini-3.5-flash-lite',
            cards: [
                ...[0, 1, 11, 6, 9, 12].map((value) => ({ type: 'number', value })),
                { type: 'adder', value: 2 },
            ],
        },
    }));

    await player.page.goto(`/room/${code}`);
    await player.page.getByRole('button', { name: 'Scan Cards' }).click();
    // The second file input is "Choose from photos"; the labelled buttons only click it.
    await player.page.locator('input[type="file"]').nth(1).setInputFiles(SCAN_PHOTO);
    await player.page.getByText('Detected Cards').waitFor();
    await shootFramed(player.page, entryPanel(player.page, 'Scan Cards'), 'scanner');
    await player.context.close();
}

// --- Launcher ------------------------------------------------------------

const CONTENT_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

/** Serves the built launcher page over http, as Chromium won't run module scripts from file://. */
function serveLauncher() {
    const server = http.createServer((request, response) => {
        const urlPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        const filePath = path.join(LAUNCHER_DIST, urlPath === '/' ? 'index.html' : urlPath);
        if (!filePath.startsWith(LAUNCHER_DIST) || !fs.existsSync(filePath)) {
            response.writeHead(404).end();
            return;
        }
        response.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(response);
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

/** Runs in the page before its scripts: a window.launcher that is already hosting. */
function installFakeLauncher({ tunnelUrl }) {
    const snapshot = { status: 'hosting', port: 7007, url: tunnelUrl, previousUrl: null, error: null, retry: null, serverLog: [], tunnelLog: [] };
    const roomStats = {
        playersOnline: 5,
        roomsLive: 2,
        rooms: [
            { code: 'KQ7P', status: 'playing', round: 3, maxScore: 200, online: 3, players: 3 },
            { code: 'ZT4M', status: 'waiting', round: 1, maxScore: 200, online: 2, players: 2 },
        ],
    };
    const settings = { geminiApiKey: 'example-key-not-a-real-one', geminiModel: 'gemini-3.5-flash-lite', secretStorage: 'encrypted' };
    const noop = () => () => {};
    window.launcher = {
        start: async () => snapshot,
        stop: async () => snapshot,
        retry: async () => snapshot,
        getState: async () => snapshot,
        onState: noop,
        onUrlChanged: noop,
        getRoomStats: async () => roomStats,
        onRoomStats: noop,
        getSettings: async () => settings,
        saveSettings: async (changes) => ({ ...settings, ...changes }),
        validateGeminiKey: async () => 'valid',
        resetData: async () => ({ ok: false, error: 'Stop hosting first.' }),
        checkForUpdate: async () => ({ updateAvailable: false, latestVersion: null, url: null }),
        openExternal: async () => {},
        openGame: async () => ({ ok: true }),
        openLicense: async () => ({ ok: true }),
        getPowerStatus: async () => ({ onBattery: false }),
        onPowerStatus: noop,
        getAppInfo: async () => ({ version: '1.0.0' }),
    };
}

async function shootLauncher(browser) {
    const server = await serveLauncher();
    try {
        const context = await browser.newContext({ viewport: LAUNCHER, deviceScaleFactor: SCALE, reducedMotion: 'reduce' });
        await context.addInitScript(installFakeLauncher, { tunnelUrl: TUNNEL_URL });
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}/`);

        await page.getByText('Players online', { exact: false }).waitFor();
        await settle(page);
        await fitViewportToContent(page);
        await page.screenshot({ path: imagePath('launcher-hosting') });

        await page.getByRole('tab', { name: 'Settings' }).click();
        await page.getByText('Card scanning', { exact: false }).first().waitFor();
        await page.setViewportSize(LAUNCHER);
        await settle(page);
        await fitViewportToContent(page);
        await page.screenshot({ path: imagePath('launcher-settings') });
        await context.close();
    } finally {
        server.close();
    }
}

// --- Main ----------------------------------------------------------------

run('npm run build');
run('npm run build:launcher');

const browser = await chromium.launch();
try {
    await shootWebApp(browser);
    await shootLauncher(browser);
} finally {
    await browser.close();
}
console.log(`Screenshots written to ${path.relative(REPO_ROOT, IMAGES_DIR)}`);
