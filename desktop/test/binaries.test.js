import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { resolveCloudflaredPath, resolveLicensePaths, resolveServerPaths } from '../src/main/binaries.js';

const RESOURCES = path.join('C:', 'Program Files', 'Flip7', 'resources');
const DESKTOP_ROOT = path.join('C:', 'repo', 'desktop');

// --- cloudflared ---

test('a packaged Windows build runs cloudflared.exe from the resources folder', () => {
    const binaryPath = resolveCloudflaredPath({
        isPackaged: true,
        resourcesPath: RESOURCES,
        desktopRoot: DESKTOP_ROOT,
        platform: 'win32',
        arch: 'x64',
    });

    assert.equal(binaryPath, path.join(RESOURCES, 'cloudflared', 'win32-x64', 'cloudflared.exe'));
});

test('a packaged macOS build runs the extension-less binary for its arch', () => {
    const binaryPath = resolveCloudflaredPath({
        isPackaged: true,
        resourcesPath: RESOURCES,
        desktopRoot: DESKTOP_ROOT,
        platform: 'darwin',
        arch: 'arm64',
    });

    assert.equal(binaryPath, path.join(RESOURCES, 'cloudflared', 'darwin-arm64', 'cloudflared'));
});

test('running from source uses the fetched binary under desktop/resources', () => {
    const binaryPath = resolveCloudflaredPath({
        isPackaged: false,
        resourcesPath: RESOURCES,
        desktopRoot: DESKTOP_ROOT,
        platform: 'linux',
        arch: 'x64',
    });

    assert.equal(binaryPath, path.join(DESKTOP_ROOT, 'resources', 'cloudflared', 'linux-x64', 'cloudflared'));
});

// --- Server and static files ---

test('a packaged build forks the server and serves the client from the resources folder', () => {
    const paths = resolveServerPaths({ isPackaged: true, resourcesPath: RESOURCES, desktopRoot: DESKTOP_ROOT });

    assert.deepEqual(paths, {
        serverRoot: path.join(RESOURCES, 'server'),
        entryPath: path.join(RESOURCES, 'server', 'src', 'index.js'),
        staticDir: path.join(RESOURCES, 'dist'),
    });
});

test('running from source forks the staged server copy under desktop/build', () => {
    const paths = resolveServerPaths({ isPackaged: false, resourcesPath: RESOURCES, desktopRoot: DESKTOP_ROOT });

    assert.deepEqual(paths, {
        serverRoot: path.join(DESKTOP_ROOT, 'build', 'server'),
        entryPath: path.join(DESKTOP_ROOT, 'build', 'server', 'src', 'index.js'),
        staticDir: path.join(DESKTOP_ROOT, 'build', 'dist'),
    });
});

// --- Licence files ---

test('a packaged build opens the licences shipped in the resources folder', () => {
    const paths = resolveLicensePaths({ isPackaged: true, resourcesPath: RESOURCES, desktopRoot: DESKTOP_ROOT });

    assert.deepEqual(paths, {
        app: path.join(RESOURCES, 'LICENSE.txt'),
        'third-party': path.join(RESOURCES, 'dist', 'THIRD_PARTY_NOTICES.txt'),
        cloudflared: path.join(RESOURCES, 'cloudflared', 'LICENSE.txt'),
    });
});

test('running from source opens the repo LICENSE, the staged notices and the fetched licence', () => {
    const paths = resolveLicensePaths({ isPackaged: false, resourcesPath: RESOURCES, desktopRoot: DESKTOP_ROOT });

    assert.deepEqual(paths, {
        app: path.join('C:', 'repo', 'LICENSE'),
        'third-party': path.join(DESKTOP_ROOT, 'build', 'dist', 'THIRD_PARTY_NOTICES.txt'),
        cloudflared: path.join(DESKTOP_ROOT, 'resources', 'cloudflared', 'LICENSE'),
    });
});
