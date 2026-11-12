// `npm run fetch:cloudflared`: downloads the pinned cloudflared release that the desktop launcher
// bundles, checks it against the SHA256 pinned below and puts it in
// desktop/resources/cloudflared/<platform>-<arch>/cloudflared[.exe]. A binary already there with
// the pinned hash is kept, so re-running is cheap. cloudflared's Apache-2.0 LICENSE from the same
// tag is fetched and checked the same way into desktop/resources/cloudflared/LICENSE, which the
// installers ship next to the binary.
//
//   node scripts/fetch-cloudflared.mjs                      # the current host
//   node scripts/fetch-cloudflared.mjs --target win32-x64   # repeatable
//   node scripts/fetch-cloudflared.mjs --all                # every target the installers ship
import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT_ROOT = path.join(PROJECT_ROOT, 'desktop', 'resources', 'cloudflared');

export const CLOUDFLARED_VERSION = '2026.10.7';

// Keyed by `${process.platform}-${process.arch}`. `assetSha256` is the release asset as
// downloaded (it matches the asset's "digest" in the GitHub release API); `binarySha256` is the
// cloudflared binary we keep, which differs only for the Mac .tgz archives.
export const TARGETS = {
    'win32-x64': {
        asset: 'cloudflared-windows-amd64.exe',
        archive: false,
        assetSha256: '2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343',
        binarySha256: '2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343',
    },
    'darwin-x64': {
        asset: 'cloudflared-darwin-amd64.tgz',
        archive: true,
        assetSha256: '02f3edfd87684dd5b705607688e4eb4b323f6e777b81e7b3a85af556aa356848',
        binarySha256: '5c55e77da7012cebca19170357e196176c48c9647cc2ead404702fa125ddbd86',
    },
    'darwin-arm64': {
        asset: 'cloudflared-darwin-arm64.tgz',
        archive: true,
        assetSha256: '3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd',
        binarySha256: '2136431d5eb467bf447d2ee514b713e192719b143aec1d9e09bf7dc290d5bb12',
    },
    'linux-x64': {
        asset: 'cloudflared-linux-amd64',
        archive: false,
        assetSha256: '1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872',
        binarySha256: '1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872',
    },
};

// cloudflared's LICENSE at the pinned tag, as served by raw.githubusercontent.com.
export const LICENSE_SHA256 = '58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd';
const LICENSE_NAME = 'LICENSE';

const BINARY_NAME = 'cloudflared';
const EXECUTABLE_MODE = 0o755;
const TAR_BLOCK_SIZE = 512;

// --- Targets and paths ------------------------------------------------------

export function downloadUrl(target, targets = TARGETS) {
    return `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${targets[target].asset}`;
}

export function licenseUrl() {
    return `https://raw.githubusercontent.com/cloudflare/cloudflared/${CLOUDFLARED_VERSION}/${LICENSE_NAME}`;
}

export function licensePath(outputRoot = DEFAULT_OUTPUT_ROOT) {
    return path.join(outputRoot, LICENSE_NAME);
}

export function outputPath(target, outputRoot = DEFAULT_OUTPUT_ROOT) {
    const isWindows = target.startsWith('win32-');
    const fileName = isWindows ? `${BINARY_NAME}.exe` : BINARY_NAME;
    return path.join(outputRoot, target, fileName);
}

function assertSupported(target, description) {
    if (!Object.hasOwn(TARGETS, target)) {
        const supported = Object.keys(TARGETS).join(', ');
        throw new Error(`Unsupported ${description} "${target}". Supported: ${supported}`);
    }
}

// --- Command line -----------------------------------------------------------

// Returns the targets to fetch. `host` is `${process.platform}-${process.arch}`, used when no
// --target or --all is given.
export function parseArgs(argv, host) {
    const targets = [];

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--all') {
            return Object.keys(TARGETS);
        }
        if (arg !== '--target') {
            throw new Error(`Unknown option "${arg}". Use --target <platform-arch> or --all.`);
        }

        const target = argv[index + 1];
        if (target === undefined) {
            throw new Error('--target needs a value such as win32-x64.');
        }
        assertSupported(target, 'target');
        targets.push(target);
        index++;
    }

    if (targets.length === 0) {
        assertSupported(host, 'host');
        targets.push(host);
    }
    return targets;
}

// --- Hashing and extraction -------------------------------------------------

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function assertHash(buffer, expected, description) {
    const actual = sha256(buffer);
    if (actual !== expected) {
        throw new Error(`SHA256 mismatch for ${description}: expected ${expected}, got ${actual}`);
    }
}

function readTarString(header, start, length) {
    const field = header.subarray(start, start + length);
    const end = field.indexOf(0);
    return field.subarray(0, end === -1 ? length : end).toString('utf8');
}

// The entry's path: ustar splits long paths into a prefix (offset 345) and a name (offset 0).
function readTarPath(header) {
    const name = readTarString(header, 0, 100);
    const isUstar = readTarString(header, 257, 6) === 'ustar';
    const prefix = isUstar ? readTarString(header, 345, 155) : '';
    return prefix ? `${prefix}/${name}` : name;
}

// Returns the contents of the first regular file in a .tar.gz whose base name is `fileName`.
// Only plain ustar/GNU entries are read, which is what cloudflared's Mac archives contain; other
// entry types (directories, pax headers) are skipped.
export function extractFileFromTarGz(archive, fileName) {
    const tar = zlib.gunzipSync(archive);
    let offset = 0;

    while (offset + TAR_BLOCK_SIZE <= tar.length) {
        const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
        const entryPath = readTarPath(header);
        if (entryPath === '') {
            break;
        }

        const size = parseInt(readTarString(header, 124, 12).trim() || '0', 8);
        const typeFlag = readTarString(header, 156, 1);
        const isRegularFile = typeFlag === '' || typeFlag === '0';
        const contentStart = offset + TAR_BLOCK_SIZE;
        if (isRegularFile && path.posix.basename(entryPath) === fileName) {
            return Buffer.from(tar.subarray(contentStart, contentStart + size));
        }

        offset = contentStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    }

    throw new Error(`No ${fileName} file in the archive`);
}

// --- Download ---------------------------------------------------------------

async function isCached(fs, binaryPath, expectedSha256) {
    try {
        return sha256(await fs.readFile(binaryPath)) === expectedSha256;
    } catch (error) {
        if (error.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

async function download(fetch, url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Download failed: HTTP ${response.status} ${url}`);
    }
    return Buffer.from(await response.arrayBuffer());
}

// Writes the release asset next to the binary, verifies it as read back from disk (so a
// truncated write is caught too) and returns the cloudflared binary inside it. The asset file is
// always deleted afterwards, so a bad download never stays in resources/.
async function saveVerifiedBinary(fs, pin, asset, binaryPath) {
    const downloadPath = `${binaryPath}.download`;

    try {
        await fs.writeFile(downloadPath, asset);
        assertHash(await fs.readFile(downloadPath), pin.assetSha256, pin.asset);

        let binary = asset;
        if (pin.archive) {
            binary = extractFileFromTarGz(asset, BINARY_NAME);
        }
        assertHash(binary, pin.binarySha256, `${BINARY_NAME} in ${pin.asset}`);
        await fs.writeFile(binaryPath, binary);
    } finally {
        await fs.rm(downloadPath, { force: true });
    }
}

/**
 * Makes sure the pinned cloudflared for `target` is in `outputRoot`.
 * @param {string} target e.g. "win32-x64"
 * @param {object} [deps] `fetch`, an fs/promises-like `fs`, `outputRoot`, and `targets` (the pin table)
 * @returns {Promise<{ status: 'cached' | 'downloaded', path: string }>}
 */
export async function fetchCloudflared(
    target,
    { fetch = globalThis.fetch, fs = fsPromises, outputRoot = DEFAULT_OUTPUT_ROOT, targets = TARGETS } = {},
) {
    const pin = targets[target];
    const binaryPath = outputPath(target, outputRoot);

    if (await isCached(fs, binaryPath, pin.binarySha256)) {
        return { status: 'cached', path: binaryPath };
    }

    await fs.mkdir(path.dirname(binaryPath), { recursive: true });
    const asset = await download(fetch, downloadUrl(target, targets));
    await saveVerifiedBinary(fs, pin, asset, binaryPath);

    if (!target.startsWith('win32-')) {
        await fs.chmod(binaryPath, EXECUTABLE_MODE);
    }
    return { status: 'downloaded', path: binaryPath };
}

/**
 * Makes sure cloudflared's LICENSE for the pinned tag is in `outputRoot`. A file already there
 * with the pinned hash is kept; a download that doesn't match is never written.
 * @param {object} [deps] `fetch`, an fs/promises-like `fs`, `outputRoot`, and `expectedSha256`
 * @returns {Promise<{ status: 'cached' | 'downloaded', path: string }>}
 */
export async function fetchCloudflaredLicense(
    { fetch = globalThis.fetch, fs = fsPromises, outputRoot = DEFAULT_OUTPUT_ROOT, expectedSha256 = LICENSE_SHA256 } = {},
) {
    const filePath = licensePath(outputRoot);
    if (await isCached(fs, filePath, expectedSha256)) {
        return { status: 'cached', path: filePath };
    }

    const license = await download(fetch, licenseUrl());
    assertHash(license, expectedSha256, `cloudflared ${LICENSE_NAME}`);
    await fs.mkdir(outputRoot, { recursive: true });
    await fs.writeFile(filePath, license);
    return { status: 'downloaded', path: filePath };
}

// --- Entry point ------------------------------------------------------------

async function main() {
    const host = `${process.platform}-${process.arch}`;
    const targets = parseArgs(process.argv.slice(2), host);

    for (const target of targets) {
        const result = await fetchCloudflared(target);
        const action = result.status === 'cached' ? 'already present' : 'downloaded and verified';
        console.log(`cloudflared ${CLOUDFLARED_VERSION} ${target}: ${action} -> ${result.path}`);
    }

    const license = await fetchCloudflaredLicense();
    console.log(`cloudflared ${CLOUDFLARED_VERSION} LICENSE: ${license.status} -> ${license.path}`);
}

const isRunDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isRunDirectly) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
