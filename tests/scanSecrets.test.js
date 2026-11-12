import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';
import {
    BETTERLEAKS_VERSION,
    TARGETS,
    batchByLength,
    binaryPath,
    buildScans,
    downloadUrl,
    ensureBetterleaks,
    extractFileFromZip,
    listUncommittedFiles,
    parseNulList,
} from '../scripts/scan-secrets.mjs';

const CACHE_ROOT = path.join('cache', 'betterleaks');

// --- Builders -------------------------------------------------------------

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

// A minimal in-memory stand-in for node:fs/promises.
function makeFakeFs(initialFiles = {}) {
    const files = new Map(Object.entries(initialFiles));
    const calls = { writes: [], chmods: [] };

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

// A zip archive of `entries` ({ name, content, method }): 0 stores, 8 deflates. CRCs are left
// at zero because the reader doesn't check them.
function makeZip(entries) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const { name, content, method = 8 } of entries) {
        const nameBytes = Buffer.from(name, 'utf8');
        const data = method === 8 ? zlib.deflateRawSync(content) : content;

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(content.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        localParts.push(local, nameBytes, data);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(content.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(offset, 42);
        centralParts.push(central, nameBytes);

        offset += local.length + nameBytes.length + data.length;
    }

    const centralDirectory = Buffer.concat(centralParts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralDirectory.length, 12);
    end.writeUInt32LE(offset, 16);

    return Buffer.concat([...localParts, centralDirectory, end]);
}

// A pin table with one target whose asset is `asset` and whose binary is `binary`.
function pinFor(target, assetName, asset, binary) {
    return {
        [target]: { asset: assetName, assetSha256: sha256(asset), binarySha256: sha256(binary) },
    };
}

// --- Pins and paths -------------------------------------------------------

test('every pinned asset belongs to the pinned version', () => {
    for (const pin of Object.values(TARGETS)) {
        assert.ok(pin.asset.startsWith(`betterleaks_${BETTERLEAKS_VERSION}_`), pin.asset);
    }
});

test('the download URL points at the pinned GitHub release asset', () => {
    assert.equal(
        downloadUrl('linux-x64'),
        `https://github.com/betterleaks/betterleaks/releases/download/v${BETTERLEAKS_VERSION}/${TARGETS['linux-x64'].asset}`,
    );
});

test('the cached binary is per version and target, with .exe only on Windows', () => {
    assert.equal(
        binaryPath('win32-x64', CACHE_ROOT),
        path.join(CACHE_ROOT, BETTERLEAKS_VERSION, 'win32-x64', 'betterleaks.exe'),
    );
    assert.equal(
        binaryPath('linux-x64', CACHE_ROOT),
        path.join(CACHE_ROOT, BETTERLEAKS_VERSION, 'linux-x64', 'betterleaks'),
    );
});

// --- Zip extraction -------------------------------------------------------

test('extractFileFromZip returns a deflated file by its base name', () => {
    const binary = Buffer.from('fake windows binary '.repeat(50));
    const zip = makeZip([
        { name: 'LICENSE', content: Buffer.from('MIT') },
        { name: 'bin/betterleaks.exe', content: binary },
    ]);

    assert.deepEqual(extractFileFromZip(zip, 'betterleaks.exe'), binary);
});

test('extractFileFromZip returns a stored file unchanged', () => {
    const binary = Buffer.from('stored bytes');
    const zip = makeZip([{ name: 'betterleaks.exe', content: binary, method: 0 }]);

    assert.deepEqual(extractFileFromZip(zip, 'betterleaks.exe'), binary);
});

test('extractFileFromZip says which file is missing', () => {
    const zip = makeZip([{ name: 'LICENSE', content: Buffer.from('MIT') }]);

    assert.throws(() => extractFileFromZip(zip, 'betterleaks.exe'), /No betterleaks.exe file/);
});

test('extractFileFromZip rejects something that is not a zip', () => {
    assert.throws(() => extractFileFromZip(Buffer.alloc(64), 'betterleaks.exe'), /Not a zip archive/);
});

test('extractFileFromZip rejects a compression method it cannot read', () => {
    const zip = makeZip([{ name: 'betterleaks.exe', content: Buffer.from('x'), method: 12 }]);

    assert.throws(() => extractFileFromZip(zip, 'betterleaks.exe'), /Unsupported zip compression method 12/);
});

// --- Download and cache ---------------------------------------------------

test('ensureBetterleaks downloads, verifies and caches the Windows binary from its zip', async () => {
    const binary = Buffer.from('the real exe');
    const asset = makeZip([{ name: 'betterleaks.exe', content: binary }]);
    const targets = pinFor('win32-x64', 'betterleaks_x_windows_x64.zip', asset, binary);
    const fs = makeFakeFs();
    const fetch = makeFakeFetch(asset);

    const result = await ensureBetterleaks('win32-x64', { fetch, fs, cacheRoot: CACHE_ROOT, targets });

    assert.deepEqual(result, { status: 'downloaded', path: binaryPath('win32-x64', CACHE_ROOT) });
    assert.deepEqual(fs.files.get(result.path), binary);
    assert.deepEqual(fs.calls.chmods, []);
});

test('ensureBetterleaks makes a downloaded Unix binary executable', async () => {
    const binary = Buffer.from('elf');
    const header = Buffer.alloc(512);
    header.write('betterleaks', 0);
    header.write('0000755\0', 100);
    header.write(binary.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('0', 156);
    header.write('ustar\0', 257);
    const body = Buffer.alloc(512);
    binary.copy(body);
    const asset = zlib.gzipSync(Buffer.concat([header, body, Buffer.alloc(1024)]));
    const targets = pinFor('linux-x64', 'betterleaks_x_linux_x64.tar.gz', asset, binary);
    const fs = makeFakeFs();

    const result = await ensureBetterleaks('linux-x64', {
        fetch: makeFakeFetch(asset),
        fs,
        cacheRoot: CACHE_ROOT,
        targets,
    });

    assert.deepEqual(fs.files.get(result.path), binary);
    assert.deepEqual(fs.calls.chmods, [{ filePath: result.path, mode: 0o755 }]);
});

test('ensureBetterleaks keeps a cached binary with the pinned hash and downloads nothing', async () => {
    const binary = Buffer.from('cached exe');
    const asset = makeZip([{ name: 'betterleaks.exe', content: binary }]);
    const targets = pinFor('win32-x64', 'a.zip', asset, binary);
    const fs = makeFakeFs({ [binaryPath('win32-x64', CACHE_ROOT)]: binary });
    const fetch = makeFakeFetch(asset);

    const result = await ensureBetterleaks('win32-x64', { fetch, fs, cacheRoot: CACHE_ROOT, targets });

    assert.equal(result.status, 'cached');
    assert.deepEqual(fetch.requested, []);
});

test('ensureBetterleaks replaces a cached binary that no longer matches the pin', async () => {
    const binary = Buffer.from('pinned exe');
    const asset = makeZip([{ name: 'betterleaks.exe', content: binary }]);
    const targets = pinFor('win32-x64', 'a.zip', asset, binary);
    const filePath = binaryPath('win32-x64', CACHE_ROOT);
    const fs = makeFakeFs({ [filePath]: Buffer.from('older version') });

    const result = await ensureBetterleaks('win32-x64', {
        fetch: makeFakeFetch(asset),
        fs,
        cacheRoot: CACHE_ROOT,
        targets,
    });

    assert.equal(result.status, 'downloaded');
    assert.deepEqual(fs.files.get(filePath), binary);
});

test('ensureBetterleaks writes nothing when the download does not match the pinned hash', async () => {
    const binary = Buffer.from('exe');
    const asset = makeZip([{ name: 'betterleaks.exe', content: binary }]);
    const targets = pinFor('win32-x64', 'a.zip', asset, binary);
    const tampered = makeZip([{ name: 'betterleaks.exe', content: Buffer.from('evil') }]);
    const fs = makeFakeFs();

    await assert.rejects(
        ensureBetterleaks('win32-x64', { fetch: makeFakeFetch(tampered), fs, cacheRoot: CACHE_ROOT, targets }),
        /SHA256 mismatch for a.zip/,
    );
    assert.deepEqual(fs.calls.writes, []);
});

test('ensureBetterleaks writes nothing when the binary inside does not match the pinned hash', async () => {
    const asset = makeZip([{ name: 'betterleaks.exe', content: Buffer.from('unexpected') }]);
    const targets = pinFor('win32-x64', 'a.zip', asset, Buffer.from('expected'));
    const fs = makeFakeFs();

    await assert.rejects(
        ensureBetterleaks('win32-x64', { fetch: makeFakeFetch(asset), fs, cacheRoot: CACHE_ROOT, targets }),
        /SHA256 mismatch for betterleaks.exe in a.zip/,
    );
    assert.deepEqual(fs.calls.writes, []);
});

test('ensureBetterleaks reports a failed download with its status', async () => {
    const fs = makeFakeFs();

    await assert.rejects(
        ensureBetterleaks('win32-x64', { fetch: makeFakeFetch(Buffer.alloc(0), { status: 404 }), fs, cacheRoot: CACHE_ROOT }),
        /Download failed: HTTP 404/,
    );
});

// --- Files to scan --------------------------------------------------------

test('parseNulList splits git -z output and drops the trailing empty entry', () => {
    assert.deepEqual(parseNulList('a.js\0dir/b c.js\0'), ['a.js', 'dir/b c.js']);
    assert.deepEqual(parseNulList(''), []);
});

test('listUncommittedFiles combines changed and untracked files once each, skipping deleted ones', () => {
    const outputs = {
        diff: 'src/changed.js\0src/deleted.js\0src/both.js\0',
        'ls-files': 'src/new.js\0src/both.js\0',
    };
    const existing = new Set(['src/changed.js', 'src/both.js', 'src/new.js']);

    const files = listUncommittedFiles({
        runGit: (args) => outputs[args[0]],
        fileExists: (file) => existing.has(file),
    });

    assert.deepEqual(files, ['src/changed.js', 'src/both.js', 'src/new.js']);
});

test('listUncommittedFiles asks git for changes against HEAD and for untracked files it does not ignore', () => {
    const calls = [];

    listUncommittedFiles({
        runGit: (args) => {
            calls.push(args);
            return '';
        },
        fileExists: () => true,
    });

    assert.deepEqual(calls, [
        ['diff', '--name-only', '-z', 'HEAD'],
        ['ls-files', '--others', '--exclude-standard', '-z'],
    ]);
});

test('batchByLength keeps each batch within the limit, counting a space per item', () => {
    assert.deepEqual(batchByLength(['aaa', 'bbb', 'ccc'], 8), [['aaa', 'bbb'], ['ccc']]);
});

test('batchByLength gives an item longer than the limit a batch of its own', () => {
    assert.deepEqual(batchByLength(['a', 'very-long-name', 'b'], 5), [['a'], ['very-long-name'], ['b']]);
});

test('batchByLength returns no batches for no items', () => {
    assert.deepEqual(batchByLength([]), []);
});

// --- Scans ----------------------------------------------------------------

test('buildScans always scans the history, redacted and verbose', () => {
    const scans = buildScans([]);

    assert.equal(scans.length, 1);
    assert.equal(scans[0][0], 'git');
    assert.ok(scans[0].includes('--redact'));
    assert.ok(scans[0].includes('--verbose'));
    assert.equal(scans[0].at(-1), '.');
});

test('buildScans adds a dir scan of the uncommitted files', () => {
    const scans = buildScans(['src/a.js', 'src/b.js']);

    assert.equal(scans.length, 2);
    assert.equal(scans[1][0], 'dir');
    assert.ok(scans[1].includes('--redact'));
    assert.deepEqual(scans[1].slice(-2), ['src/a.js', 'src/b.js']);
});

// Betterleaks only finds .betterleaks.toml by itself when it scans one directory; given a list of
// files it falls back to the default rules and the allowlists are lost.
test('buildScans passes the project config to every scan', () => {
    const scans = buildScans(['src/a.js']);

    for (const scan of scans) {
        const flagIndex = scan.indexOf('--config');
        assert.notEqual(flagIndex, -1, `no --config in ${scan.join(' ')}`);
        assert.equal(path.basename(scan[flagIndex + 1]), '.betterleaks.toml');
    }
});
