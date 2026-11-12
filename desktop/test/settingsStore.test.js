import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSettingsStore, DEFAULT_SETTINGS, SETTINGS_FILE_NAME } from '../src/main/settingsStore.js';

let appDataDir;
let gameDataDir;

// What a store without a cipher returns when nothing is saved.
const PLAIN_DEFAULTS = { ...DEFAULT_SETTINGS, secretStorage: 'plain-text' };

beforeEach(() => {
    appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-settings-'));
    gameDataDir = path.join(appDataDir, 'data');
});

afterEach(() => {
    fs.rmSync(appDataDir, { recursive: true, force: true });
});

function settingsPath() {
    return path.join(appDataDir, SETTINGS_FILE_NAME);
}

function writeSettingsFile(text) {
    fs.writeFileSync(settingsPath(), text);
}

// --- Loading ---

test('load returns the defaults when no settings file exists', () => {
    const store = createSettingsStore({ appDataDir, gameDataDir });

    assert.deepEqual(store.load(), PLAIN_DEFAULTS);
});

test('the default model matches the server default', () => {
    assert.equal(DEFAULT_SETTINGS.geminiModel, 'gemini-3.5-flash-lite');
    assert.equal(DEFAULT_SETTINGS.geminiApiKey, '');
});

test('load returns the defaults when the file is not valid JSON', () => {
    writeSettingsFile('{ not json');
    const store = createSettingsStore({ appDataDir, gameDataDir });

    assert.deepEqual(store.load(), PLAIN_DEFAULTS);
});

test('load returns the defaults when the file holds something other than an object', () => {
    for (const text of ['null', '[]', '"key"', '42']) {
        writeSettingsFile(text);
        const store = createSettingsStore({ appDataDir, gameDataDir });

        assert.deepEqual(store.load(), PLAIN_DEFAULTS, text);
    }
});

test('load keeps saved values and fills missing ones with defaults', () => {
    writeSettingsFile(JSON.stringify({ geminiApiKey: 'abc' }));
    const store = createSettingsStore({ appDataDir, gameDataDir });

    assert.deepEqual(store.load(), { ...PLAIN_DEFAULTS, geminiApiKey: 'abc' });
});

test('load ignores unknown keys and values of the wrong type', () => {
    writeSettingsFile(JSON.stringify({ geminiApiKey: 7, geminiModel: 'gemini-x', extra: true }));
    const store = createSettingsStore({ appDataDir, gameDataDir });

    assert.deepEqual(store.load(), { ...PLAIN_DEFAULTS, geminiModel: 'gemini-x' });
});

test('load falls back to the default model when the saved model is blank', () => {
    writeSettingsFile(JSON.stringify({ geminiModel: '   ' }));
    const store = createSettingsStore({ appDataDir, gameDataDir });

    assert.equal(store.load().geminiModel, DEFAULT_SETTINGS.geminiModel);
});

// --- Saving ---

test('save merges changes into the stored settings and returns the result', () => {
    const store = createSettingsStore({ appDataDir, gameDataDir });
    store.save({ geminiApiKey: 'first' });

    const saved = store.save({ geminiModel: 'gemini-y' });

    assert.deepEqual(saved, { geminiApiKey: 'first', geminiModel: 'gemini-y', secretStorage: 'plain-text' });
    assert.deepEqual(store.load(), saved);
});

test('save trims the key and model', () => {
    const store = createSettingsStore({ appDataDir, gameDataDir });

    const saved = store.save({ geminiApiKey: '  abc \n', geminiModel: ' gemini-z ' });

    assert.deepEqual(saved, { geminiApiKey: 'abc', geminiModel: 'gemini-z', secretStorage: 'plain-text' });
});

test('save drops unknown keys and non-string values', () => {
    const store = createSettingsStore({ appDataDir, gameDataDir });

    // @ts-expect-error the IPC bridge can pass anything; the store must not trust it
    const saved = store.save({ geminiApiKey: 5, other: 'x' });

    assert.deepEqual(saved, PLAIN_DEFAULTS);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))).sort(), [
        'geminiApiKey',
        'geminiModel',
    ]);
});

test('save creates the app-data folder when it does not exist yet', () => {
    const nestedDir = path.join(appDataDir, 'nested', 'deeper');
    const store = createSettingsStore({ appDataDir: nestedDir, gameDataDir: path.join(nestedDir, 'data') });

    store.save({ geminiApiKey: 'abc' });

    assert.equal(store.load().geminiApiKey, 'abc');
});

test('save leaves no temporary file behind', () => {
    const store = createSettingsStore({ appDataDir, gameDataDir });

    store.save({ geminiApiKey: 'abc' });

    assert.deepEqual(fs.readdirSync(appDataDir), [SETTINGS_FILE_NAME]);
});

test('save replaces a corrupt file', () => {
    writeSettingsFile('garbage');
    const store = createSettingsStore({ appDataDir, gameDataDir });

    store.save({ geminiApiKey: 'abc' });

    assert.equal(store.load().geminiApiKey, 'abc');
});

// --- Reset data ---

test('resetData deletes the game data folder and keeps the settings', () => {
    const store = createSettingsStore({ appDataDir, gameDataDir });
    store.save({ geminiApiKey: 'abc' });
    fs.mkdirSync(path.join(gameDataDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(gameDataDir, 'sub', 'flip7.db'), 'data');

    store.resetData();

    assert.equal(fs.existsSync(gameDataDir), false);
    assert.equal(store.load().geminiApiKey, 'abc');
});

test('resetData does nothing when the game data folder does not exist', () => {
    const store = createSettingsStore({ appDataDir, gameDataDir });

    assert.doesNotThrow(() => store.resetData());
});

test('resetData refuses a game data folder outside the app-data folder', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-outside-'));
    try {
        const store = createSettingsStore({ appDataDir, gameDataDir: outsideDir });

        assert.throws(() => store.resetData(), /inside/);
        assert.equal(fs.existsSync(outsideDir), true);
    } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
    }
});

test('resetData refuses the app-data folder itself and paths that climb out of it', () => {
    for (const unsafeDir of [appDataDir, path.join(appDataDir, '..'), path.join(appDataDir, 'data', '..')]) {
        const store = createSettingsStore({ appDataDir, gameDataDir: unsafeDir });

        assert.throws(() => store.resetData(), /inside/, unsafeDir);
    }
    assert.equal(fs.existsSync(appDataDir), true);
});

test('resetData refuses a sibling folder whose name starts with the app-data folder name', () => {
    const siblingDir = `${appDataDir}-sibling`;
    fs.mkdirSync(siblingDir);
    try {
        const store = createSettingsStore({ appDataDir, gameDataDir: siblingDir });

        assert.throws(() => store.resetData(), /inside/);
        assert.equal(fs.existsSync(siblingDir), true);
    } finally {
        fs.rmSync(siblingDir, { recursive: true, force: true });
    }
});

// --- Encryption ---

/**
 * A stand-in for Electron's safeStorage: "encrypts" by prefixing, and refuses to decrypt anything
 * it didn't produce, like a value from another machine. `fails` makes one method throw, like a
 * Keychain access the user denied.
 * @typedef {{ available?: boolean, backend?: string,
 *   fails?: 'isEncryptionAvailable' | 'encryptString' }} FakeCipherOptions
 * @param {FakeCipherOptions} [options]
 */
function createFakeCipher({ available = true, backend, fails } = {}) {
    /** @param {string} method */
    function failIfAsked(method) {
        if (fails === method) {
            throw new Error(`${method} failed`);
        }
    }

    /** @type {import('../src/main/settingsStore.js').Cipher} */
    const cipher = {
        isEncryptionAvailable: () => {
            failIfAsked('isEncryptionAvailable');
            return available;
        },
        encryptString: (text) => {
            failIfAsked('encryptString');
            return Buffer.from(`sealed:${text}`, 'utf8');
        },
        decryptString: (buffer) => {
            const text = buffer.toString('utf8');
            if (!text.startsWith('sealed:')) {
                throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
            }
            return text.slice('sealed:'.length);
        },
    };
    if (backend !== undefined) {
        cipher.getSelectedStorageBackend = () => backend;
    }
    return cipher;
}

/** @param {string} text */
function sealed(text) {
    return { encrypted: Buffer.from(`sealed:${text}`, 'utf8').toString('base64') };
}

/** @param {string} text */
function foreignCiphertext(text) {
    return { encrypted: Buffer.from(text, 'utf8').toString('base64') };
}

function readSettingsFile() {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
}

/** @param {FakeCipherOptions} [options] */
function createEncryptedStore(options = {}) {
    /** @type {string[]} */
    const warnings = [];
    const store = createSettingsStore({
        appDataDir,
        gameDataDir,
        cipher: createFakeCipher(options),
        onWarning: (message) => warnings.push(message),
    });
    return { store, warnings };
}

test('the settings file is readable only by its owner', { skip: process.platform === 'win32' }, () => {
    const store = createSettingsStore({ appDataDir, gameDataDir });

    store.save({ geminiApiKey: 'abc' });

    assert.equal(fs.statSync(settingsPath()).mode & 0o777, 0o600);
});

test('save stores the key encrypted when the system can encrypt', () => {
    const { store } = createEncryptedStore();

    const saved = store.save({ geminiApiKey: 'AIza-secret' });

    assert.equal(saved.geminiApiKey, 'AIza-secret');
    assert.deepEqual(readSettingsFile().geminiApiKey, sealed('AIza-secret'));
    assert.equal(fs.readFileSync(settingsPath(), 'utf8').includes('AIza-secret'), false);
});

test('load decrypts an encrypted key', () => {
    writeSettingsFile(JSON.stringify({ geminiApiKey: sealed('AIza-secret'), geminiModel: 'gemini-x' }));
    const { store } = createEncryptedStore();

    assert.deepEqual(store.load(), { geminiApiKey: 'AIza-secret', geminiModel: 'gemini-x', secretStorage: 'encrypted' });
});

test('load rewrites a plain-text key encrypted', () => {
    writeSettingsFile(JSON.stringify({ geminiApiKey: ' AIza-old ', geminiModel: 'gemini-x' }));
    const { store } = createEncryptedStore();

    assert.equal(store.load().geminiApiKey, 'AIza-old');
    assert.deepEqual(readSettingsFile(), { geminiApiKey: sealed('AIza-old'), geminiModel: 'gemini-x' });
    assert.deepEqual(fs.readdirSync(appDataDir), [SETTINGS_FILE_NAME]);
});

test('an empty key is left as it is, with nothing to encrypt', () => {
    writeSettingsFile(JSON.stringify({ geminiApiKey: '' }));
    const { store } = createEncryptedStore();

    store.save({ geminiModel: 'gemini-x' });

    assert.equal(readSettingsFile().geminiApiKey, '');
});

test('without a usable keyring the key is saved in plain text and load says so', () => {
    for (const options of [{ available: false }, { backend: 'basic_text' }]) {
        const { store } = createEncryptedStore(options);

        const saved = store.save({ geminiApiKey: 'AIza-plain' });

        assert.equal(saved.secretStorage, 'plain-text', JSON.stringify(options));
        assert.equal(readSettingsFile().geminiApiKey, 'AIza-plain');
        assert.equal(store.load().geminiApiKey, 'AIza-plain');
    }
});

test('a real keyring backend on Linux counts as encrypted', () => {
    const { store } = createEncryptedStore({ backend: 'gnome_libsecret' });

    assert.equal(store.save({ geminiApiKey: 'abc' }).secretStorage, 'encrypted');
    assert.deepEqual(readSettingsFile().geminiApiKey, sealed('abc'));
});

test('without a cipher the store keeps plain text', () => {
    const store = createSettingsStore({ appDataDir, gameDataDir });

    assert.equal(store.save({ geminiApiKey: 'abc' }).secretStorage, 'plain-text');
    assert.equal(readSettingsFile().geminiApiKey, 'abc');
});

test('a key that cannot be decrypted counts as missing and warns without the value', () => {
    writeSettingsFile(JSON.stringify({ geminiApiKey: foreignCiphertext('from-another-machine') }));
    const { store, warnings } = createEncryptedStore();

    assert.equal(store.load().geminiApiKey, '');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Gemini API key/);
    assert.equal(warnings[0].includes('from-another-machine'), false);
});

test('an encrypted key counts as missing when the keyring is no longer available', () => {
    writeSettingsFile(JSON.stringify({ geminiApiKey: sealed('abc') }));
    const { store, warnings } = createEncryptedStore({ available: false });

    assert.equal(store.load().geminiApiKey, '');
    assert.equal(warnings.length, 1);
});

test('a malformed stored key is ignored', () => {
    for (const stored of [{ encrypted: 5 }, { other: 'x' }, ['a'], 7]) {
        writeSettingsFile(JSON.stringify({ geminiApiKey: stored }));
        const { store, warnings } = createEncryptedStore();

        assert.equal(store.load().geminiApiKey, '', JSON.stringify(stored));
        assert.deepEqual(warnings, []);
    }
});

test('save ignores secretStorage and sessionSecret in the changes', () => {
    const { store } = createEncryptedStore();

    // @ts-expect-error the renderer is untrusted and may send anything
    store.save({ secretStorage: 'plain-text', sessionSecret: 'chosen-by-renderer' });

    assert.deepEqual(Object.keys(readSettingsFile()).sort(), ['geminiApiKey', 'geminiModel']);
    assert.notEqual(store.getSessionSecret(), 'chosen-by-renderer');
});

// --- Session secret ---

test('getSessionSecret generates a secret once, stores it encrypted and keeps returning it', () => {
    const { store } = createEncryptedStore();

    const secret = store.getSessionSecret();

    assert.match(secret, /^[0-9a-f]{64}$/);
    assert.deepEqual(readSettingsFile().sessionSecret, sealed(secret));
    assert.equal(store.getSessionSecret(), secret);
    assert.equal(createEncryptedStore().store.getSessionSecret(), secret);
});

test('the session secret is never part of load or save results', () => {
    const { store } = createEncryptedStore();
    store.getSessionSecret();

    assert.equal('sessionSecret' in store.load(), false);
    assert.equal('sessionSecret' in store.save({ geminiApiKey: 'abc' }), false);
});

test('saving settings keeps the session secret', () => {
    const { store } = createEncryptedStore();
    const secret = store.getSessionSecret();

    store.save({ geminiApiKey: 'abc', geminiModel: 'gemini-x' });

    assert.equal(store.getSessionSecret(), secret);
});

test('a plain-text session secret is read and rewritten encrypted', () => {
    writeSettingsFile(JSON.stringify({ sessionSecret: 'old-secret' }));
    const { store } = createEncryptedStore();

    assert.equal(store.getSessionSecret(), 'old-secret');
    assert.deepEqual(readSettingsFile().sessionSecret, sealed('old-secret'));
});

test('a session secret that cannot be decrypted is replaced with a new one', () => {
    writeSettingsFile(JSON.stringify({ sessionSecret: foreignCiphertext('foreign') }));
    const { store, warnings } = createEncryptedStore();

    const secret = store.getSessionSecret();

    assert.match(secret, /^[0-9a-f]{64}$/);
    assert.deepEqual(readSettingsFile().sessionSecret, sealed(secret));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /session secret/);
});

test('without a keyring the session secret is stored in plain text', () => {
    const { store } = createEncryptedStore({ available: false });

    const secret = store.getSessionSecret();

    assert.equal(readSettingsFile().sessionSecret, secret);
});

test('resetData keeps the session secret', () => {
    const { store } = createEncryptedStore();
    const secret = store.getSessionSecret();

    store.resetData();

    assert.equal(store.getSessionSecret(), secret);
});

// --- Keyring trouble ---

test('an encrypted session secret is kept when the keyring is unavailable for now, and this run uses a temporary one', () => {
    const storedSecret = sealed('kept-secret');
    writeSettingsFile(JSON.stringify({ sessionSecret: storedSecret }));
    const { store, warnings } = createEncryptedStore({ available: false });

    const secret = store.getSessionSecret();

    assert.match(secret, /^[0-9a-f]{64}$/);
    assert.equal(store.getSessionSecret(), secret);
    assert.deepEqual(readSettingsFile().sessionSecret, storedSecret);
    assert.ok(warnings.length >= 1);
    assert.equal(createEncryptedStore().store.getSessionSecret(), 'kept-secret');
});

test('an encrypted key is kept when the keyring is unavailable for now and other settings change', () => {
    const storedKey = sealed('kept-key');
    writeSettingsFile(JSON.stringify({ geminiApiKey: storedKey }));
    const { store } = createEncryptedStore({ available: false });

    assert.equal(store.save({ geminiModel: 'gemini-x' }).geminiApiKey, '');

    assert.deepEqual(readSettingsFile().geminiApiKey, storedKey);
    assert.equal(createEncryptedStore().store.load().geminiApiKey, 'kept-key');
});

test('a keyring check that throws counts as no keyring and breaks nothing', () => {
    writeSettingsFile(JSON.stringify({ geminiApiKey: sealed('kept-key'), sessionSecret: sealed('kept-secret') }));
    const { store } = createEncryptedStore({ fails: 'isEncryptionAvailable' });

    assert.equal(store.load().secretStorage, 'plain-text');
    assert.equal(store.save({ geminiModel: 'gemini-x' }).geminiModel, 'gemini-x');
    assert.match(store.getSessionSecret(), /^[0-9a-f]{64}$/);
    assert.deepEqual(readSettingsFile().geminiApiKey, sealed('kept-key'));
    assert.deepEqual(readSettingsFile().sessionSecret, sealed('kept-secret'));
});

test('a plain-text key stays as it is when encrypting it fails', () => {
    writeSettingsFile(JSON.stringify({ geminiApiKey: 'AIza-plain' }));
    const { store, warnings } = createEncryptedStore({ fails: 'encryptString' });

    assert.equal(store.load().geminiApiKey, 'AIza-plain');
    assert.equal(readSettingsFile().geminiApiKey, 'AIza-plain');
    assert.ok(warnings.length >= 1);
    assert.equal(warnings.some((message) => message.includes('AIza-plain')), false);
});

test('a key is still saved, in plain text, when encrypting it fails', () => {
    const { store, warnings } = createEncryptedStore({ fails: 'encryptString' });

    assert.equal(store.save({ geminiApiKey: 'AIza-new' }).geminiApiKey, 'AIza-new');

    assert.equal(readSettingsFile().geminiApiKey, 'AIza-new');
    assert.ok(warnings.length >= 1);
});

test('a new session secret is still made, in plain text, when encrypting it fails', () => {
    const { store } = createEncryptedStore({ fails: 'encryptString' });

    const secret = store.getSessionSecret();

    assert.equal(readSettingsFile().sessionSecret, secret);
});

// --- Leftover server secret file ---

test('removePlainSessionSecretFile deletes the file the server wrote before the launcher set the secret', () => {
    const { store } = createEncryptedStore();
    fs.mkdirSync(gameDataDir, { recursive: true });
    fs.writeFileSync(path.join(gameDataDir, 'session-secret'), 'plain');
    fs.writeFileSync(path.join(gameDataDir, 'flip7.db'), 'data');

    store.removePlainSessionSecretFile();

    assert.deepEqual(fs.readdirSync(gameDataDir), ['flip7.db']);
});

test('removePlainSessionSecretFile does nothing when there is no file', () => {
    const { store, warnings } = createEncryptedStore();

    assert.doesNotThrow(() => store.removePlainSessionSecretFile());
    assert.deepEqual(warnings, []);
});

test('removePlainSessionSecretFile warns instead of throwing when the file cannot be deleted', () => {
    const { store, warnings } = createEncryptedStore();
    // A non-empty folder in its place makes a non-recursive delete fail on every platform.
    fs.mkdirSync(path.join(gameDataDir, 'session-secret', 'inner'), { recursive: true });

    assert.doesNotThrow(() => store.removePlainSessionSecretFile());
    assert.equal(warnings.length, 1);
});
