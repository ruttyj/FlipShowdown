// `npm run scan:secrets`: scans the repo for leaked secrets (API keys, tokens, private keys) with
// Betterleaks (MIT, https://github.com/betterleaks/betterleaks). Two scans run:
//
//   1. every commit in the git history, and
//   2. the files that differ from HEAD (staged, unstaged and new untracked files), so a secret is
//      caught before it is committed.
//
// Files git ignores (.env, node_modules, dist, ...) are never scanned. The pinned release is
// downloaded on first use, checked against the SHA256 pinned below and cached in
// node_modules/.cache/betterleaks. Rules and allowlists live in .betterleaks.toml.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { extractFileFromTarGz } from './fetch-cloudflared.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CACHE_ROOT = path.join(PROJECT_ROOT, 'node_modules', '.cache', 'betterleaks');

export const BETTERLEAKS_VERSION = '1.9.0';

// Keyed by `${process.platform}-${process.arch}`. `assetSha256` is the release asset as
// downloaded (it matches the asset's "digest" in the GitHub release API); `binarySha256` is the
// betterleaks binary inside it, which is what the cache check hashes.
export const TARGETS = {
    'win32-x64': {
        asset: 'betterleaks_1.9.0_windows_x64.zip',
        assetSha256: 'b765daec9fda475b031b5a5159798cbe4294a3f2a50683cbc0471226e376d3da',
        binarySha256: '41a3dc5e75712d52d25aa7203b0b6bc2fa9c796fe5109d3835c60226a9a69352',
    },
    'win32-arm64': {
        asset: 'betterleaks_1.9.0_windows_arm64.zip',
        assetSha256: '3e5b9b6cdbfe8d486ae2dd2fa137473dc9ab42bf50317f051b73561121861816',
        binarySha256: 'e0f6c8cac0dabf271b499abdfe43c3b5794db1f36d80f7af2a963d69fac97f89',
    },
    'darwin-x64': {
        asset: 'betterleaks_1.9.0_darwin_x64.tar.gz',
        assetSha256: '68dfd83458d9e7f90663daa7a81c7f944083b170dae82e4f5f8d0581ed519ef1',
        binarySha256: '1581b1ad0d7d640459c728344c9d431339c8855cd2b5ccd35a9a56a7260b071a',
    },
    'darwin-arm64': {
        asset: 'betterleaks_1.9.0_darwin_arm64.tar.gz',
        assetSha256: '83dd7eaab13d44a1e8e347a17064cdef153a1478db473276d41b38d55613d3f2',
        binarySha256: '70d2103c2915aababa0e1eea121bd3db0ff0da86bee40ddc6f5982181acaf6d0',
    },
    'linux-x64': {
        asset: 'betterleaks_1.9.0_linux_x64.tar.gz',
        assetSha256: 'f8b185a39ffcece2a1ca82bf3a4e7435cd81963ffd16b7a9128daf75f35f6de7',
        binarySha256: '0ace40b41652344608f89967fe93c6caf4faae9a4df20423632c7efb02a4d4e1',
    },
    'linux-arm64': {
        asset: 'betterleaks_1.9.0_linux_arm64.tar.gz',
        assetSha256: '1d39116e0a58dc94574715e2aa12a2dbd5062f193eee3fec011fef6ba06bd13b',
        binarySha256: '488e0aa9f34e4144c70ba58ab83f1cda11fb4a5f84897b513e55b2afe71b7e8a',
    },
};

const EXECUTABLE_MODE = 0o755;

// Betterleaks only discovers .betterleaks.toml by itself when it scans one directory. The
// uncommitted-files scan passes a list of files, so without --config it would silently drop the
// allowlists and report their values as leaks.
const CONFIG_PATH = path.join(PROJECT_ROOT, '.betterleaks.toml');

// Shared by both scans: use the project config, print each finding (without --verbose only a
// count is shown) with the secret value hidden, in plain text for CI logs.
const COMMON_FLAGS = ['--config', CONFIG_PATH, '--verbose', '--redact', '--no-banner', '--no-color'];

// Windows rejects command lines over 32,767 characters, so the file list is passed in batches
// that stay well under it.
const MAX_ARGS_LENGTH = 24000;

// --- Targets and paths ------------------------------------------------------

function binaryName(target) {
    if (target.startsWith('win32-')) {
        return 'betterleaks.exe';
    }
    return 'betterleaks';
}

export function downloadUrl(target, targets = TARGETS) {
    return `https://github.com/betterleaks/betterleaks/releases/download/v${BETTERLEAKS_VERSION}/${targets[target].asset}`;
}

export function binaryPath(target, cacheRoot = DEFAULT_CACHE_ROOT) {
    return path.join(cacheRoot, BETTERLEAKS_VERSION, target, binaryName(target));
}

function assertSupported(target) {
    if (!Object.hasOwn(TARGETS, target)) {
        const supported = Object.keys(TARGETS).join(', ');
        throw new Error(`Betterleaks has no pinned build for "${target}". Supported: ${supported}`);
    }
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

const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_METHOD_STORED = 0;
const ZIP_METHOD_DEFLATED = 8;

// The end-of-central-directory record is the last 22 bytes plus an optional comment of up to
// 64 KB, so it is found by searching backwards for its signature.
function findEndOfCentralDirectory(archive) {
    const earliest = Math.max(0, archive.length - 22 - 0xffff);

    for (let offset = archive.length - 22; offset >= earliest; offset--) {
        if (archive.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) {
            return offset;
        }
    }
    throw new Error('Not a zip archive: no end of central directory');
}

function readZipEntryData(archive, entry) {
    if (archive.readUInt32LE(entry.localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER) {
        throw new Error(`Corrupt zip: bad local header for ${entry.name}`);
    }

    // The local header's name and extra lengths can differ from the central directory's.
    const nameLength = archive.readUInt16LE(entry.localHeaderOffset + 26);
    const extraLength = archive.readUInt16LE(entry.localHeaderOffset + 28);
    const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
    const data = archive.subarray(dataStart, dataStart + entry.compressedSize);

    if (entry.method === ZIP_METHOD_STORED) {
        return Buffer.from(data);
    }
    if (entry.method === ZIP_METHOD_DEFLATED) {
        return zlib.inflateRawSync(data);
    }
    throw new Error(`Unsupported zip compression method ${entry.method} for ${entry.name}`);
}

// Returns the contents of the first file in a zip whose base name is `fileName`. Only what
// Betterleaks' Windows archives use is supported: stored or deflated entries, no zip64.
export function extractFileFromZip(archive, fileName) {
    const endOffset = findEndOfCentralDirectory(archive);
    const entryCount = archive.readUInt16LE(endOffset + 10);
    let offset = archive.readUInt32LE(endOffset + 16);

    for (let index = 0; index < entryCount; index++) {
        if (archive.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_ENTRY) {
            throw new Error('Corrupt zip: bad central directory entry');
        }

        const nameLength = archive.readUInt16LE(offset + 28);
        const extraLength = archive.readUInt16LE(offset + 30);
        const commentLength = archive.readUInt16LE(offset + 32);
        const name = archive.toString('utf8', offset + 46, offset + 46 + nameLength);

        if (path.posix.basename(name) === fileName) {
            const entry = {
                name,
                method: archive.readUInt16LE(offset + 10),
                compressedSize: archive.readUInt32LE(offset + 20),
                localHeaderOffset: archive.readUInt32LE(offset + 42),
            };
            return readZipEntryData(archive, entry);
        }

        offset += 46 + nameLength + extraLength + commentLength;
    }

    throw new Error(`No ${fileName} file in the archive`);
}

function extractBinary(pin, asset, fileName) {
    if (pin.asset.endsWith('.zip')) {
        return extractFileFromZip(asset, fileName);
    }
    return extractFileFromTarGz(asset, fileName);
}

// --- Download ---------------------------------------------------------------

async function isCached(fs, filePath, expectedSha256) {
    try {
        return sha256(await fs.readFile(filePath)) === expectedSha256;
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

/**
 * Makes sure the pinned Betterleaks binary for `target` is in the cache. A binary already there
 * with the pinned hash is kept; a download or binary that doesn't match is never written.
 * @param {string} target e.g. "win32-x64"
 * @param {object} [deps] `fetch`, an fs/promises-like `fs`, `cacheRoot`, and `targets` (the pin table)
 * @returns {Promise<{ status: 'cached' | 'downloaded', path: string }>}
 */
export async function ensureBetterleaks(
    target,
    { fetch = globalThis.fetch, fs = fsPromises, cacheRoot = DEFAULT_CACHE_ROOT, targets = TARGETS } = {},
) {
    const pin = targets[target];
    const filePath = binaryPath(target, cacheRoot);

    if (await isCached(fs, filePath, pin.binarySha256)) {
        return { status: 'cached', path: filePath };
    }

    const asset = await download(fetch, downloadUrl(target, targets));
    assertHash(asset, pin.assetSha256, pin.asset);
    const binary = extractBinary(pin, asset, binaryName(target));
    assertHash(binary, pin.binarySha256, `${binaryName(target)} in ${pin.asset}`);

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, binary);
    if (!target.startsWith('win32-')) {
        await fs.chmod(filePath, EXECUTABLE_MODE);
    }
    return { status: 'downloaded', path: filePath };
}

// --- Files to scan ----------------------------------------------------------

// Splits git's `-z` output (paths separated by NUL) into a list, dropping the empty tail.
export function parseNulList(output) {
    return output.split('\0').filter((entry) => entry !== '');
}

// The working-tree files that differ from HEAD: changed (staged or not) plus untracked files git
// doesn't ignore. Deleted files are dropped because there is nothing left to scan.
export function listUncommittedFiles({ runGit, fileExists }) {
    const changed = parseNulList(runGit(['diff', '--name-only', '-z', 'HEAD']));
    const untracked = parseNulList(runGit(['ls-files', '--others', '--exclude-standard', '-z']));
    const unique = new Set([...changed, ...untracked]);

    const files = [];
    for (const file of unique) {
        if (fileExists(file)) {
            files.push(file);
        }
    }
    return files;
}

// Splits `items` into batches whose joined length (plus a separating space each) stays within
// `maxLength`. An item longer than the limit still gets a batch of its own.
export function batchByLength(items, maxLength = MAX_ARGS_LENGTH) {
    const batches = [];
    let current = [];
    let currentLength = 0;

    for (const item of items) {
        const itemLength = item.length + 1;
        const wouldOverflow = current.length > 0 && currentLength + itemLength > maxLength;
        if (wouldOverflow) {
            batches.push(current);
            current = [];
            currentLength = 0;
        }
        current.push(item);
        currentLength += itemLength;
    }

    if (current.length > 0) {
        batches.push(current);
    }
    return batches;
}

// --- Scans ------------------------------------------------------------------

// The Betterleaks argument lists to run: one for the history, then one per batch of
// uncommitted files.
export function buildScans(uncommittedFiles) {
    const scans = [['git', ...COMMON_FLAGS, '.']];

    for (const batch of batchByLength(uncommittedFiles)) {
        scans.push(['dir', ...COMMON_FLAGS, ...batch]);
    }
    return scans;
}

function runGit(args) {
    const result = spawnSync('git', args, { cwd: PROJECT_ROOT, encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
    }
    return result.stdout;
}

function fileExists(file) {
    return existsSync(path.join(PROJECT_ROOT, file));
}

// Runs every scan, even after one finds a leak, so all findings are shown in one go. Returns
// true when none found anything.
function runScans(binary, scans) {
    let allClean = true;

    for (const args of scans) {
        const result = spawnSync(binary, args, { cwd: PROJECT_ROOT, stdio: 'inherit' });
        if (result.error) {
            throw result.error;
        }
        if (result.status !== 0) {
            allClean = false;
        }
    }
    return allClean;
}

// --- Entry point ------------------------------------------------------------

async function main() {
    const target = `${process.platform}-${process.arch}`;
    assertSupported(target);

    const betterleaks = await ensureBetterleaks(target);
    if (betterleaks.status === 'downloaded') {
        console.log(`Betterleaks ${BETTERLEAKS_VERSION}: downloaded and verified -> ${betterleaks.path}`);
    }

    const uncommittedFiles = listUncommittedFiles({ runGit, fileExists });
    console.log(`Scanning the git history and ${uncommittedFiles.length} uncommitted file(s).`);

    const allClean = runScans(betterleaks.path, buildScans(uncommittedFiles));
    if (!allClean) {
        console.error('Secret scan failed: see the findings above. docs/testing.md says how to handle one.');
        process.exitCode = 1;
    }
}

const isRunDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isRunDirectly) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
