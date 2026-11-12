import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveAppVersion } from '../src/main/appVersion.js';

test('a packaged build reports the version electron-builder baked in', () => {
    const version = resolveAppVersion({
        isPackaged: true,
        appVersion: '1.2.3',
        rootPackageJson: { version: '9.9.9' },
    });

    assert.equal(version, '1.2.3');
});

test('from source the version comes from the root package.json, not desktop/package.json', () => {
    const version = resolveAppVersion({
        isPackaged: false,
        appVersion: '0.0.0',
        rootPackageJson: { version: '1.0.0' },
    });

    assert.equal(version, '1.0.0');
});

test('from source without a readable root version, the Electron version is kept', () => {
    assert.equal(resolveAppVersion({ isPackaged: false, appVersion: '0.0.0', rootPackageJson: null }), '0.0.0');
    assert.equal(resolveAppVersion({ isPackaged: false, appVersion: '0.0.0', rootPackageJson: {} }), '0.0.0');
});
