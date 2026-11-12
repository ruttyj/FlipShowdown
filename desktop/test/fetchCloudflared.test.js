import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';
import {
    CLOUDFLARED_VERSION,
    TARGETS,
    downloadUrl,
    extractFileFromTarGz,
    fetchCloudflared,
    fetchCloudflaredLicense,
    licensePath,
    licenseUrl,
    LICENSE_SHA256,
    outputPath,
    parseArgs,
} from '../../scripts/fetch-cloudflared.mjs';

const OUTPUT_ROOT = path.join('out', 'cloudflared');

// --- Builders -------------------------------------------------------------

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

// A minimal in-memory stand-in for node:fs/promises, recording what was written and removed.
function makeFakeFs(initialFiles = {}) {
    const files = new Map(Object.entries(initialFiles));
    const calls = { writes: [], removed: [], chmods: [] };

    return {
        files,
        calls,
        async readFile(filePath) {
            if (!files.has(filePath)) {
                throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: 'ENOENT' });
            }
            return files.get(filePath);
        },
        async writeFile(filePath, data) {
            calls.writes.push(filePath);
            files.set(filePath, Buffer.from(data));
        },
        async mkdir() {},
        async rm(filePath) {
            calls.removed.push(filePath);
            files.delete(filePath);
        },
        async chmod(filePath, mode) {
            calls.chmods.push({ filePath, mode });
        },
    };
}

// A fetch that answers every URL with `body` and remembers which URLs were asked for.
function makeFakeFetch(body, { status = 200 } = {}) {
    const requested = [];

    async function fakeFetch(url) {
        requested.push(url);
        return {
            ok: status >= 200 && status < 300,
            status,
            arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        };
    }

    return Object.assign(fakeFetch, { requested });
}

// A ustar header block for one regular file.
function tarHeader(name, size) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 'utf8');
    header.write('0000755\0', 100);
    header.write(size.toString(8).padStart(11, '0') + '\0', 124);
    header.write('0', 156);
    header.write('ustar\0', 257);
    return header;
}

function makeTarGz(entries) {
    const blocks = [];
    for (const [name, content] of Object.entries(entries)) {
        const padding = (512 - (content.length % 512)) % 512;
        blocks.push(tarHeader(name, content.length), content, Buffer.alloc(padding));
    }
    blocks.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(blocks));
}

// The real target table with one target's pinned hashes swapped for ones matching a fake download.
function targetsWith(target, pins) {
    return { ...TARGETS, [target]: { ...TARGETS[target], ...pins } };
}

// --- Target mapping -------------------------------------------------------

test('each supported target maps to its official release asset', () => {
    assert.equal(TARGETS['win32-x64'].asset, 'cloudflared-windows-amd64.exe');
    assert.equal(TARGETS['linux-x64'].asset, 'cloudflared-linux-amd64');
    assert.equal(TARGETS['darwin-x64'].asset, 'cloudflared-darwin-amd64.tgz');
    assert.equal(TARGETS['darwin-arm64'].asset, 'cloudflared-darwin-arm64.tgz');
});

test('the download URL points at the pinned GitHub release', () => {
    assert.equal(
        downloadUrl('linux-x64'),
        `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64`,
    );
});

test('the binary lands under <platform>-<arch>, with .exe only on Windows', () => {
    assert.equal(outputPath('win32-x64', OUTPUT_ROOT), path.join(OUTPUT_ROOT, 'win32-x64', 'cloudflared.exe'));
    assert.equal(outputPath('darwin-arm64', OUTPUT_ROOT), path.join(OUTPUT_ROOT, 'darwin-arm64', 'cloudflared'));
});

test('every pinned hash is a SHA256 hex digest', () => {
    for (const target of Object.values(TARGETS)) {
        assert.match(target.assetSha256, /^[0-9a-f]{64}$/);
        assert.match(target.binarySha256, /^[0-9a-f]{64}$/);
    }
});

// --- Command line ---------------------------------------------------------

test('with no arguments the current host is fetched', () => {
    assert.deepEqual(parseArgs([], 'linux-x64'), ['linux-x64']);
});

test('--target can be repeated', () => {
    assert.deepEqual(parseArgs(['--target', 'win32-x64', '--target', 'darwin-arm64'], 'linux-x64'), [
        'win32-x64',
        'darwin-arm64',
    ]);
});

test('--all selects every supported target', () => {
    assert.deepEqual(parseArgs(['--all'], 'linux-x64'), Object.keys(TARGETS));
});

test('an unsupported target is rejected with the supported list', () => {
    assert.throws(() => parseArgs(['--target', 'linux-arm64'], 'win32-x64'), /linux-arm64.*win32-x64/s);
});

test('an unsupported host is rejected when no target is given', () => {
    assert.throws(() => parseArgs([], 'freebsd-x64'), /freebsd-x64/);
});

test('an unknown option is rejected', () => {
    assert.throws(() => parseArgs(['--everything'], 'win32-x64'), /--everything/);
});

test('--target without a value is rejected', () => {
    assert.throws(() => parseArgs(['--target'], 'win32-x64'), /--target/);
});

// --- Download and verify --------------------------------------------------

test('a plain binary is downloaded, verified and written to its target folder', async () => {
    const binary = Buffer.from('fake linux cloudflared');
    const targets = targetsWith('linux-x64', { assetSha256: sha256(binary), binarySha256: sha256(binary) });
    const fs = makeFakeFs();
    const fetch = makeFakeFetch(binary);

    const result = await fetchCloudflared('linux-x64', { fetch, fs, outputRoot: OUTPUT_ROOT, targets });

    const target = outputPath('linux-x64', OUTPUT_ROOT);
    assert.deepEqual(result, { status: 'downloaded', path: target });
    assert.deepEqual(fs.files.get(target), binary);
    assert.deepEqual([...fs.files.keys()], [target]);
    assert.deepEqual(fetch.requested, [downloadUrl('linux-x64')]);
    assert.deepEqual(fs.calls.chmods, [{ filePath: target, mode: 0o755 }]);
});

test('a Windows binary is not made executable with chmod', async () => {
    const binary = Buffer.from('fake windows cloudflared');
    const targets = targetsWith('win32-x64', { assetSha256: sha256(binary), binarySha256: sha256(binary) });
    const fs = makeFakeFs();

    await fetchCloudflared('win32-x64', { fetch: makeFakeFetch(binary), fs, outputRoot: OUTPUT_ROOT, targets });

    assert.deepEqual(fs.calls.chmods, []);
});

test('a Mac archive is extracted and only the cloudflared binary is kept', async () => {
    const binary = Buffer.from('fake mac cloudflared '.repeat(40));
    const archive = makeTarGz({ 'README.txt': Buffer.from('notes'), cloudflared: binary });
    const targets = targetsWith('darwin-arm64', { assetSha256: sha256(archive), binarySha256: sha256(binary) });
    const fs = makeFakeFs();

    await fetchCloudflared('darwin-arm64', { fetch: makeFakeFetch(archive), fs, outputRoot: OUTPUT_ROOT, targets });

    const target = outputPath('darwin-arm64', OUTPUT_ROOT);
    assert.deepEqual(fs.files.get(target), binary);
    assert.deepEqual([...fs.files.keys()], [target]);
});

test('a download whose hash does not match fails and deletes the downloaded file', async () => {
    const fs = makeFakeFs();
    const fetch = makeFakeFetch(Buffer.from('tampered'));

    await assert.rejects(
        fetchCloudflared('linux-x64', { fetch, fs, outputRoot: OUTPUT_ROOT }),
        /SHA256 mismatch.*cloudflared-linux-amd64/,
    );

    assert.equal(fs.calls.writes.length, 1);
    assert.deepEqual(fs.calls.removed, fs.calls.writes);
    assert.equal(fs.files.size, 0);
});

test('an extracted binary whose hash does not match fails and leaves nothing behind', async () => {
    const archive = makeTarGz({ cloudflared: Buffer.from('unexpected binary') });
    const targets = targetsWith('darwin-x64', { assetSha256: sha256(archive) });
    const fs = makeFakeFs();

    await assert.rejects(
        fetchCloudflared('darwin-x64', { fetch: makeFakeFetch(archive), fs, outputRoot: OUTPUT_ROOT, targets }),
        /SHA256 mismatch/,
    );

    assert.equal(fs.files.size, 0);
});

test('a failed HTTP response is reported with its status', async () => {
    const fs = makeFakeFs();
    const fetch = makeFakeFetch(Buffer.alloc(0), { status: 404 });

    await assert.rejects(fetchCloudflared('linux-x64', { fetch, fs, outputRoot: OUTPUT_ROOT }), /404/);
    assert.equal(fs.files.size, 0);
});

test('an archive without a cloudflared binary is rejected', () => {
    const archive = makeTarGz({ 'README.txt': Buffer.from('notes') });

    assert.throws(() => extractFileFromTarGz(archive, 'cloudflared'), /cloudflared/);
});

test('a file inside a folder in the archive is found by its base name', () => {
    const binary = Buffer.from('nested');
    const archive = makeTarGz({ 'release/cloudflared': binary });

    assert.deepEqual(extractFileFromTarGz(archive, 'cloudflared'), binary);
});

// --- Cache ----------------------------------------------------------------

test('a binary already present with the pinned hash is not downloaded again', async () => {
    const binary = Buffer.from('cached linux cloudflared');
    const targets = targetsWith('linux-x64', { binarySha256: sha256(binary) });
    const target = outputPath('linux-x64', OUTPUT_ROOT);
    const fs = makeFakeFs({ [target]: binary });
    const fetch = makeFakeFetch(Buffer.from('should not be fetched'));

    const result = await fetchCloudflared('linux-x64', { fetch, fs, outputRoot: OUTPUT_ROOT, targets });

    assert.deepEqual(result, { status: 'cached', path: target });
    assert.deepEqual(fetch.requested, []);
    assert.deepEqual(fs.calls.writes, []);
});

test('a binary present with a different hash is replaced', async () => {
    const binary = Buffer.from('fresh linux cloudflared');
    const targets = targetsWith('linux-x64', { assetSha256: sha256(binary), binarySha256: sha256(binary) });
    const target = outputPath('linux-x64', OUTPUT_ROOT);
    const fs = makeFakeFs({ [target]: Buffer.from('stale') });
    const fetch = makeFakeFetch(binary);

    const result = await fetchCloudflared('linux-x64', { fetch, fs, outputRoot: OUTPUT_ROOT, targets });

    assert.equal(result.status, 'downloaded');
    assert.deepEqual(fs.files.get(target), binary);
});

// --- Licence --------------------------------------------------------------

test('the licence URL is the LICENSE file at the pinned tag, with a SHA256 pin', () => {
    assert.equal(
        licenseUrl(),
        `https://raw.githubusercontent.com/cloudflare/cloudflared/${CLOUDFLARED_VERSION}/LICENSE`,
    );
    assert.match(LICENSE_SHA256, /^[0-9a-f]{64}$/);
});

test('the licence is downloaded, verified and saved next to the binaries', async () => {
    const license = Buffer.from('Apache License 2.0');
    const fs = makeFakeFs();
    const fetch = makeFakeFetch(license);

    const result = await fetchCloudflaredLicense({ fetch, fs, outputRoot: OUTPUT_ROOT, expectedSha256: sha256(license) });

    const target = licensePath(OUTPUT_ROOT);
    assert.equal(target, path.join(OUTPUT_ROOT, 'LICENSE'));
    assert.deepEqual(result, { status: 'downloaded', path: target });
    assert.deepEqual(fs.files.get(target), license);
    assert.deepEqual(fetch.requested, [licenseUrl()]);
});

test('a licence whose hash does not match is never written', async () => {
    const fs = makeFakeFs();

    await assert.rejects(
        fetchCloudflaredLicense({ fetch: makeFakeFetch(Buffer.from('tampered')), fs, outputRoot: OUTPUT_ROOT }),
        /SHA256 mismatch.*LICENSE/,
    );
    assert.equal(fs.files.size, 0);
});

test('a licence already present with the pinned hash is not downloaded again', async () => {
    const license = Buffer.from('cached licence');
    const fs = makeFakeFs({ [licensePath(OUTPUT_ROOT)]: license });
    const fetch = makeFakeFetch(Buffer.from('should not be fetched'));

    const result = await fetchCloudflaredLicense({ fetch, fs, outputRoot: OUTPUT_ROOT, expectedSha256: sha256(license) });

    assert.equal(result.status, 'cached');
    assert.deepEqual(fetch.requested, []);
});

test('a failed licence download is reported with its status', async () => {
    const fs = makeFakeFs();

    await assert.rejects(
        fetchCloudflaredLicense({ fetch: makeFakeFetch(Buffer.alloc(0), { status: 404 }), fs, outputRoot: OUTPUT_ROOT }),
        /404/,
    );
});
