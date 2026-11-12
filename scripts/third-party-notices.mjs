// Builds THIRD_PARTY_NOTICES.txt: the licence of every production dependency of the client (root
// package, which also bundles the launcher page) and the server. The Vite build emits it into
// dist/, so the web app serves it at /licenses and the installers ship it with the client.
// Electron's own licences come from electron-builder (LICENSE.electron.txt, LICENSES.chromium.html)
// and cloudflared's from scripts/fetch-cloudflared.mjs.
//
//   node scripts/third-party-notices.mjs [output-file]   # default: print to stdout
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PACKAGE_ROOTS = [PROJECT_ROOT, path.join(PROJECT_ROOT, 'server')];

const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying|notice)(\.|-|$)/i;
const SEPARATOR = '-'.repeat(78);

/**
 * @typedef {object} PackageNotice
 * @property {string} name
 * @property {string} version
 * @property {string} license   the SPDX expression from package.json, or "UNKNOWN"
 * @property {string[]} texts   the contents of its LICENSE / NOTICE files
 */

/** The package's name from its lockfile key, e.g. "node_modules/a/node_modules/@b/c" -> "@b/c". */
export function packageNameFromLockKey(lockKey) {
    const marker = 'node_modules/';
    return lockKey.slice(lockKey.lastIndexOf(marker) + marker.length);
}

/** package.json's licence, in its modern string form or the old `{ type }` / `licenses` forms. */
export function readLicenseField(packageJson) {
    if (typeof packageJson.license === 'string') {
        return packageJson.license;
    }
    if (packageJson.license && typeof packageJson.license.type === 'string') {
        return packageJson.license.type;
    }
    if (Array.isArray(packageJson.licenses)) {
        return packageJson.licenses.map((entry) => entry.type).join(' OR ');
    }
    return 'UNKNOWN';
}

function readLicenseTexts(packageDir) {
    const fileNames = fs.readdirSync(packageDir).filter((fileName) => LICENSE_FILE_PATTERN.test(fileName)).sort();
    const texts = [];

    for (const fileName of fileNames) {
        const filePath = path.join(packageDir, fileName);
        if (fs.statSync(filePath).isFile()) {
            texts.push(fs.readFileSync(filePath, 'utf8').trim());
        }
    }
    return texts;
}

/**
 * The installed production packages of one npm project, from its package-lock.json. Dev-only
 * packages and ones not installed on this platform (optional builds for other OSes) are left out.
 * @param {string} projectRoot
 * @returns {PackageNotice[]}
 */
export function collectProductionPackages(projectRoot) {
    const lock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
    const notices = [];

    for (const [lockKey, entry] of Object.entries(lock.packages)) {
        if (lockKey === '' || entry.dev || entry.link) {
            continue;
        }
        const packageDir = path.join(projectRoot, lockKey);
        const packageJsonPath = path.join(packageDir, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            continue;
        }

        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        notices.push({
            name: packageJson.name ?? packageNameFromLockKey(lockKey),
            version: packageJson.version ?? entry.version,
            license: readLicenseField(packageJson),
            texts: readLicenseTexts(packageDir),
        });
    }
    return notices;
}

/**
 * One entry per name@version, sorted by name then version.
 * @param {PackageNotice[]} notices
 * @returns {PackageNotice[]}
 */
export function dedupeNotices(notices) {
    const byKey = new Map();
    for (const notice of notices) {
        const key = `${notice.name}@${notice.version}`;
        if (!byKey.has(key)) {
            byKey.set(key, notice);
        }
    }

    return [...byKey.values()].sort((a, b) => {
        return a.name.localeCompare(b.name) || a.version.localeCompare(b.version);
    });
}

/**
 * The notices file's text.
 * @param {PackageNotice[]} notices  already deduped and sorted
 * @returns {string}
 */
export function renderNotices(notices) {
    const lines = [
        'Flip Showdown: third-party notices',
        '',
        'Flip Showdown includes the open-source packages below. Each is listed with its licence and',
        'the licence text it ships with.',
        '',
    ];

    for (const notice of notices) {
        lines.push(SEPARATOR, `${notice.name} ${notice.version}`, `License: ${notice.license}`, '');
        if (notice.texts.length === 0) {
            lines.push('(No licence file included in the package.)', '');
        }
        for (const text of notice.texts) {
            lines.push(text, '');
        }
    }
    return lines.join('\n');
}

/** The notices for the given npm projects, ready to write. */
export function buildThirdPartyNotices(packageRoots = DEFAULT_PACKAGE_ROOTS) {
    const notices = packageRoots.flatMap((projectRoot) => collectProductionPackages(projectRoot));
    return renderNotices(dedupeNotices(notices));
}

// --- Entry point ------------------------------------------------------------

function main() {
    const text = buildThirdPartyNotices();
    const outputFile = process.argv[2];
    if (outputFile) {
        fs.writeFileSync(outputFile, text);
        return;
    }
    process.stdout.write(text);
}

const isRunDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isRunDirectly) {
    main();
}
