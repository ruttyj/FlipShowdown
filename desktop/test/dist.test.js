import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    assertRendererBuilt,
    cloudflaredTargetsFor,
    electronBuilderArgs,
    electronBuilderCommand,
    npmScriptCommand,
    otherMacArch,
    readAppVersion,
} from '../scripts/dist.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopDir, '..');

// --- Version ---

test('the app version comes from the root package.json', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-dist-'));
    fs.writeFileSync(path.join(tempRoot, 'package.json'), JSON.stringify({ version: '2.3.4' }));

    try {
        assert.equal(readAppVersion(tempRoot), '2.3.4');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

// The update check (src/main/updateCheck.js parseVersion) only compares plain x.y.z versions.
test('the repo version is a plain x.y.z the update check can compare', () => {
    assert.match(readAppVersion(repoRoot), /^\d+\.\d+\.\d+$/);
});

test('a root package.json without a version is rejected', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-dist-'));
    fs.writeFileSync(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));

    try {
        assert.throws(() => readAppVersion(tempRoot), /no version/);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

// --- cloudflared targets ---

test('Windows and Linux bundle the x64 cloudflared only', () => {
    assert.deepEqual(cloudflaredTargetsFor('win32'), ['win32-x64']);
    assert.deepEqual(cloudflaredTargetsFor('linux'), ['linux-x64']);
});

test('the universal Mac build bundles both cloudflared arches', () => {
    assert.deepEqual(cloudflaredTargetsFor('darwin'), ['darwin-x64', 'darwin-arm64']);
});

test('an unsupported build platform is rejected', () => {
    assert.throws(() => cloudflaredTargetsFor('freebsd'), /freebsd/);
});

// --- Mac arches ---

test('the other Mac arch is the one the universal build still needs', () => {
    assert.equal(otherMacArch('arm64'), 'x64');
    assert.equal(otherMacArch('x64'), 'arm64');
});

// --- electron-builder arguments ---

test('electron-builder gets the root version and the caller arguments', () => {
    const args = electronBuilderArgs('1.0.0', ['--dir', '--win', '--x64']);

    assert.deepEqual(args, ['-c.extraMetadata.version=1.0.0', '--dir', '--win', '--x64']);
});

// --- Launcher renderer ---

test('packaging stops when the launcher renderer has not been built', () => {
    const tempDesktop = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-dist-'));

    try {
        assert.throws(() => assertRendererBuilt(tempDesktop), /dist-renderer.*build:launcher/s);
    } finally {
        fs.rmSync(tempDesktop, { recursive: true, force: true });
    }
});

test('packaging goes ahead when dist-renderer/index.html exists', () => {
    const tempDesktop = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-dist-'));
    fs.mkdirSync(path.join(tempDesktop, 'dist-renderer'));
    fs.writeFileSync(path.join(tempDesktop, 'dist-renderer', 'index.html'), '<!doctype html>');

    try {
        assert.doesNotThrow(() => assertRendererBuilt(tempDesktop));
    } finally {
        fs.rmSync(tempDesktop, { recursive: true, force: true });
    }
});

// --- Commands (no shell, so arguments reach the tools unsplit) ---

test('electron-builder runs through Node with its CLI script and the arguments as given', () => {
    const command = electronBuilderCommand(['--dir', '-c.productName=Flip 7 & Co']);

    assert.equal(command.file, process.execPath);
    assert.match(command.args[0], /electron-builder[\\/]cli\.js$/);
    assert.deepEqual(command.args.slice(1), ['--dir', '-c.productName=Flip 7 & Co']);
});

test('a root npm script runs through the npm that started dist', () => {
    const command = npmScriptCommand('build:launcher', '/tools/npm-cli.js');

    assert.deepEqual(command, { file: process.execPath, args: ['/tools/npm-cli.js', 'run', 'build:launcher'] });
});

test('running a root npm script outside npm is rejected with how to run dist', () => {
    assert.throws(() => npmScriptCommand('build', undefined), /npm run dist/);
});
