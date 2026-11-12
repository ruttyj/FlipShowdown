import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPermissionAllowed } from '../src/main/pagePermissions.js';

// Electron asks for clipboard-sanitized-write on navigator.clipboard.writeText, so denying it broke
// every Copy button in the launcher (X74).
test('the page may write to the clipboard', () => {
    assert.equal(isPermissionAllowed('clipboard-sanitized-write'), true);
});

test('every other permission stays denied', () => {
    for (const permission of ['clipboard-read', 'media', 'notifications', 'geolocation', 'openExternal', 'unknown']) {
        assert.equal(isPermissionAllowed(permission), false, permission);
    }
});
