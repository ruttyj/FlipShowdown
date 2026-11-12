// Launcher settings (decisions 7 and 10): the optional Gemini key and model, and the server's
// session secret, kept as JSON in the app-data folder, plus "Reset data", which deletes the
// game's SQLite folder.
//
// The two secrets are encrypted with an injected cipher (Electron's safeStorage: DPAPI on
// Windows, the Keychain on macOS, the keyring on Linux) and stored as { "encrypted": "<base64>" }.
// Without a usable keyring (none at all, or Linux's 'basic_text' fallback with its hard-coded
// password) they are stored in plain text rather than not at all. A plain-text secret found while
// encryption works is rewritten encrypted on read. A secret that can't be decrypted (the profile
// was copied from another machine, the keyring was reset) counts as missing and is reported
// through onWarning, never with its value. An encrypted secret met while the keyring is
// unavailable is kept on disk and goes unused for this run. Cipher errors never escape: the store
// falls back to plain text, so Settings and Start keep working.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SETTINGS_FILE_NAME = 'settings.json';
// The file the server writes its session secret to when SESSION_SECRET is not set
// (server/src/config.js). Launchers before the secret moved here left one in the data folder.
const SERVER_SESSION_SECRET_FILE_NAME = 'session-secret';

/**
 * Electron's safeStorage, or a test fake with the same shape.
 * @typedef {object} Cipher
 * @property {() => boolean} isEncryptionAvailable
 * @property {(text: string) => Buffer} encryptString
 * @property {(encrypted: Buffer) => string} decryptString  throws when it can't decrypt
 * @property {() => string} [getSelectedStorageBackend]  Linux only
 */

/** @typedef {'encrypted' | 'plain-text'} SecretStorage */

/**
 * @typedef {object} Settings
 * @property {string} geminiApiKey  '' when the user skipped the key (AI card scanning stays off).
 * @property {string} geminiModel
 */

/** @typedef {Settings & { secretStorage: SecretStorage }} LoadedSettings */

/**
 * A secret as it sits in the file: plain text, or the cipher's output in base64.
 * @typedef {string | { encrypted: string }} StoredSecret
 */

/**
 * The settings file. Every field is optional, and the secrets may be in either form.
 * @typedef {object} StoredSettings
 * @property {StoredSecret} [geminiApiKey]
 * @property {string} [geminiModel]
 * @property {StoredSecret} [sessionSecret]
 */

/** The secrets in the file, by name, with how a warning names them. */
const SECRET_LABELS = /** @type {const} */ ({
    geminiApiKey: 'Gemini API key',
    sessionSecret: 'session secret',
});

/** @type {Readonly<Settings>} */
export const DEFAULT_SETTINGS = Object.freeze({
    geminiApiKey: '',
    // Same default as server/src/config.js.
    geminiModel: 'gemini-3.5-flash-lite',
});

// --- Cleaning values ---------------------------------------------------------

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Keeps only the settings the user may change that hold strings, trimmed. Anything else (unknown
 * keys, the session secret, wrong types, a blank model) is dropped so it can't reach the server's
 * environment.
 * @param {unknown} raw
 * @returns {Partial<Settings>}
 */
function cleanChanges(raw) {
    if (!isPlainObject(raw)) {
        return {};
    }

    /** @type {Partial<Settings>} */
    const cleaned = {};
    if (typeof raw.geminiApiKey === 'string') {
        cleaned.geminiApiKey = raw.geminiApiKey.trim();
    }
    if (typeof raw.geminiModel === 'string' && raw.geminiModel.trim() !== '') {
        cleaned.geminiModel = raw.geminiModel.trim();
    }
    return cleaned;
}

/**
 * @param {unknown} value
 * @returns {value is StoredSecret}
 */
function isStoredSecret(value) {
    if (typeof value === 'string') {
        return true;
    }
    return isPlainObject(value) && typeof value.encrypted === 'string';
}

/**
 * Keeps only the known fields of the file in a valid form.
 * @param {unknown} raw
 * @returns {StoredSettings}
 */
function cleanStoredSettings(raw) {
    if (!isPlainObject(raw)) {
        return {};
    }

    /** @type {StoredSettings} */
    const stored = {};
    if (isStoredSecret(raw.geminiApiKey)) {
        stored.geminiApiKey = raw.geminiApiKey;
    }
    if (typeof raw.geminiModel === 'string' && raw.geminiModel.trim() !== '') {
        stored.geminiModel = raw.geminiModel.trim();
    }
    if (isStoredSecret(raw.sessionSecret)) {
        stored.sessionSecret = raw.sessionSecret;
    }
    return stored;
}

// --- Encryption ----------------------------------------------------------------

/**
 * The cipher and where to report trouble with it.
 * @typedef {{ cipher: Cipher | undefined, onWarning: (message: string) => void }} SecretContext
 */

/**
 * What a stored secret decodes to. `isLocked` means it is encrypted but can't be decrypted right
 * now because the keyring is unavailable, so it must be kept rather than replaced.
 * @typedef {{ value: string, isLocked: boolean }} DecodedSecret
 */

/**
 * True when the cipher really protects secrets. Linux's 'basic_text' backend encrypts with a
 * password hard-coded in Chromium, which is no better than plain text. A check that throws
 * counts as no keyring.
 * @param {Cipher | undefined} cipher
 * @returns {cipher is Cipher}
 */
function canEncrypt(cipher) {
    if (!cipher) {
        return false;
    }

    try {
        if (!cipher.isEncryptionAvailable()) {
            return false;
        }
        return cipher.getSelectedStorageBackend?.() !== 'basic_text';
    } catch {
        return false;
    }
}

/**
 * The form a secret is written in. An empty secret has nothing to hide and stays ''. When
 * encrypting fails (macOS Keychain access denied, say) it is kept in plain text, with a warning,
 * rather than not saved.
 * @param {SecretContext} context
 * @param {string} value
 * @param {string} label  how the warning names the secret
 * @returns {StoredSecret}
 */
function encodeSecret({ cipher, onWarning }, value, label) {
    if (value === '' || !canEncrypt(cipher)) {
        return value;
    }

    try {
        return { encrypted: cipher.encryptString(value).toString('base64') };
    } catch {
        onWarning(`Encrypting the ${label} failed, so it is stored unencrypted.`);
        return value;
    }
}

/**
 * The secret's value: '' when it is missing, can't be decrypted or is locked for now.
 * @param {SecretContext} context
 * @param {StoredSecret | undefined} stored
 * @param {string} label  how the warning names the secret
 * @returns {DecodedSecret}
 */
function decodeSecret({ cipher, onWarning }, stored, label) {
    if (stored === undefined) {
        return { value: '', isLocked: false };
    }
    if (typeof stored === 'string') {
        return { value: stored.trim(), isLocked: false };
    }

    if (!canEncrypt(cipher)) {
        onWarning(`The saved ${label} is encrypted but the keyring is unavailable, so it is unused for now.`);
        return { value: '', isLocked: true };
    }
    try {
        return { value: cipher.decryptString(Buffer.from(stored.encrypted, 'base64')).trim(), isLocked: false };
    } catch {
        onWarning(`The saved ${label} couldn't be decrypted (was the profile copied from another computer?), so it is treated as missing.`);
        return { value: '', isLocked: false };
    }
}

/**
 * Encrypts the plain-text secrets in `stored`, in place. Returns true when it changed anything;
 * a secret that fails to encrypt stays as it was.
 * @param {SecretContext} context
 * @param {StoredSettings} stored
 */
function encryptPlainSecrets(context, stored) {
    if (!canEncrypt(context.cipher)) {
        return false;
    }

    let changed = false;
    for (const [name, label] of Object.entries(SECRET_LABELS)) {
        const secretName = /** @type {keyof typeof SECRET_LABELS} */ (name);
        const value = stored[secretName];
        if (typeof value !== 'string' || value.trim() === '') {
            continue;
        }

        const encoded = encodeSecret(context, value.trim(), label);
        if (typeof encoded !== 'string') {
            stored[secretName] = encoded;
            changed = true;
        }
    }
    return changed;
}

// --- File access ---------------------------------------------------------------

/**
 * Reads the settings file, treating a missing or unreadable one as empty.
 * @param {string} filePath
 * @returns {unknown}
 */
function readJsonFile(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return {};
    }
}

/**
 * Writes to a temporary file and renames it over the target, so a crash mid-write leaves the
 * old settings rather than a half-written file.
 * @param {string} filePath
 * @param {unknown} value
 */
function writeJsonFileAtomically(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.tmp`;
    // Owner-only, like the server's own session-secret file: without a keyring the secrets are in
    // plain text. The rename keeps the mode; Windows ignores it.
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
}

/**
 * True when `childDir` is strictly inside `parentDir` (not equal to it, not beside it).
 * @param {string} parentDir
 * @param {string} childDir
 */
function isStrictlyInside(parentDir, childDir) {
    const relative = path.relative(path.resolve(parentDir), path.resolve(childDir));
    const climbsOut = relative === '..' || relative.startsWith(`..${path.sep}`);
    return relative !== '' && !climbsOut && !path.isAbsolute(relative);
}

/** A new random session secret: 64 hex characters. */
function createSessionSecret() {
    return crypto.randomBytes(32).toString('hex');
}

// --- Store ---------------------------------------------------------------------

/**
 * @param {object} options
 * @param {string} options.appDataDir   Folder for settings.json (Electron's `userData`).
 * @param {string} options.gameDataDir  The server's SQLite folder; must be inside `appDataDir`.
 * @param {Cipher} [options.cipher]     Electron's safeStorage, usable only after app 'ready'.
 *   Without one the secrets are stored in plain text.
 * @param {(message: string) => void} [options.onWarning]  Told about a secret that can't be
 *   decrypted or a leftover file that can't be deleted.
 */
export function createSettingsStore({ appDataDir, gameDataDir, cipher, onWarning = () => {} }) {
    const settingsPath = path.join(appDataDir, SETTINGS_FILE_NAME);
    /** @type {SecretContext} */
    const secretContext = { cipher, onWarning };
    // The session secret for this run while the stored one is locked (see getSessionSecret).
    /** @type {string | undefined} */
    let temporarySessionSecret;

    /**
     * The settings file, with any plain-text secret rewritten encrypted when possible.
     * @returns {StoredSettings}
     */
    function readStored() {
        const stored = cleanStoredSettings(readJsonFile(settingsPath));
        if (encryptPlainSecrets(secretContext, stored)) {
            writeJsonFileAtomically(settingsPath, stored);
        }
        return stored;
    }

    /** @returns {SecretStorage} */
    function secretStorage() {
        return canEncrypt(cipher) ? 'encrypted' : 'plain-text';
    }

    /**
     * The settings the launcher page may see. The session secret is never among them.
     * @returns {LoadedSettings}
     */
    function load() {
        const stored = readStored();
        return {
            geminiApiKey: decodeSecret(secretContext, stored.geminiApiKey, SECRET_LABELS.geminiApiKey).value,
            geminiModel: stored.geminiModel ?? DEFAULT_SETTINGS.geminiModel,
            secretStorage: secretStorage(),
        };
    }

    /**
     * Merges `changes` into the stored settings and returns the saved result. Only the key and
     * model can be changed; anything else in `changes` is ignored.
     * @param {Partial<Settings>} changes
     * @returns {LoadedSettings}
     */
    function save(changes) {
        const stored = readStored();
        const cleaned = cleanChanges(changes);

        /** @type {StoredSettings} */
        const next = {
            geminiApiKey: stored.geminiApiKey ?? '',
            geminiModel: cleaned.geminiModel ?? stored.geminiModel ?? DEFAULT_SETTINGS.geminiModel,
        };
        if (cleaned.geminiApiKey !== undefined) {
            next.geminiApiKey = encodeSecret(secretContext, cleaned.geminiApiKey, SECRET_LABELS.geminiApiKey);
        }
        if (stored.sessionSecret !== undefined) {
            next.sessionSecret = stored.sessionSecret;
        }
        writeJsonFileAtomically(settingsPath, next);
        return load();
    }

    /**
     * The secret the server signs sessions with, created on first use. It lives in the settings
     * file rather than the data folder, so Reset data keeps it.
     * @returns {string}
     */
    function getSessionSecret() {
        const stored = readStored();
        const existing = decodeSecret(secretContext, stored.sessionSecret, SECRET_LABELS.sessionSecret);
        if (existing.value !== '') {
            return existing.value;
        }

        // A keyring that is only unavailable for now (a Linux keyring not unlocked yet) must not
        // cost the stored secret, so this run signs with a temporary one kept in memory.
        if (existing.isLocked) {
            temporarySessionSecret ??= createSessionSecret();
            return temporarySessionSecret;
        }

        const secret = createSessionSecret();
        const sessionSecret = encodeSecret(secretContext, secret, SECRET_LABELS.sessionSecret);
        writeJsonFileAtomically(settingsPath, { ...stored, sessionSecret });
        return secret;
    }

    /**
     * Deletes the plain-text session secret the server wrote to the data folder when the launcher
     * didn't pass one. Best effort: a failure is reported, not thrown, so hosting still starts.
     */
    function removePlainSessionSecretFile() {
        try {
            fs.rmSync(path.join(gameDataDir, SERVER_SESSION_SECRET_FILE_NAME), { force: true });
        } catch (error) {
            onWarning(`Couldn't delete the old plain-text session secret file: ${/** @type {Error} */ (error).message}`);
        }
    }

    /**
     * Deletes the game data folder. Stop the server first: it holds the database open.
     * Throws, deleting nothing, unless the folder is strictly inside the app-data folder.
     */
    function resetData() {
        if (!isStrictlyInside(appDataDir, gameDataDir)) {
            throw new Error(`Refusing to reset data: ${gameDataDir} is not inside ${appDataDir}`);
        }

        fs.rmSync(gameDataDir, { recursive: true, force: true });
    }

    return { load, save, getSessionSecret, removePlainSessionSecretFile, resetData };
}
