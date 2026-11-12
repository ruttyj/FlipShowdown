import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readDesktopPackage() {
    return JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
}

// --- Package wiring ---

test('the desktop package entry point exists', () => {
    const { main } = readDesktopPackage();

    assert.ok(fs.existsSync(path.join(desktopDir, main)), `missing ${main}`);
});

test('the desktop package uses ES modules like the rest of the repo', () => {
    assert.equal(readDesktopPackage().type, 'module');
});
