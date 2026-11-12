// Renders the site favicon (public/favicon.svg) to desktop/build-resources/icon.png, the
// launcher's app and window icon. electron-builder turns that PNG into the .ico and .icns, and
// main.js sets it on the window. Rerun after changing the favicon and commit the PNG.
//
// Uses the root's Playwright Chromium, so gradients and shadows render as in a browser.
// Usage: node scripts/icon.mjs   (from desktop/, or `npm run icon`)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAVICON = path.join(DESKTOP_ROOT, '..', 'public', 'favicon.svg');
const ICON = path.join(DESKTOP_ROOT, 'build-resources', 'icon.png');
// electron-builder needs at least 512px for the macOS icon.
const SIZE = 512;

async function main() {
    const svg = fs.readFileSync(FAVICON, 'utf8');
    const html = `<!doctype html><style>html,body{margin:0;background:transparent}
svg{display:block;width:${SIZE}px;height:${SIZE}px}</style>${svg}`;

    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
        await page.setContent(html);
        fs.mkdirSync(path.dirname(ICON), { recursive: true });
        await page.screenshot({ path: ICON, omitBackground: true });
    } finally {
        await browser.close();
    }
    console.log(`Wrote ${path.relative(DESKTOP_ROOT, ICON)}`);
}

await main();
