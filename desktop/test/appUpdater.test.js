import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAppUpdater, inAppInstallSupport } from '../src/main/appUpdater.js';

// --- Fakes ---

/**
 * Stands in for electron-updater's autoUpdater. The test settles the check and the download by
 * hand, and fires the events the real one emits.
 */
class FakeUpdater extends EventEmitter {
    autoDownload = true;
    autoInstallOnAppQuit = false;
    calls = [];
    checkResult = { isUpdateAvailable: true, updateInfo: { version: '1.3.0' } };
    checkError = null;
    downloadError = null;

    async checkForUpdates() {
        this.calls.push('check');
        if (this.checkError) {
            throw this.checkError;
        }
        return this.checkResult;
    }

    async downloadUpdate() {
        this.calls.push('download');
        if (this.downloadError) {
            this.emit('error', this.downloadError);
            throw this.downloadError;
        }
        this.emit('download-progress', { percent: 41.6 });
        this.emit('update-downloaded', { version: '1.3.0' });
        return [];
    }

    quitAndInstall() {
        this.calls.push('quitAndInstall');
    }
}

const SUPPORTED = { canInstall: true, unsupportedReason: null };

function setup({ support = SUPPORTED, hosting = false } = {}) {
    const updater = new FakeUpdater();
    const state = { hosting };
    const appUpdater = createAppUpdater({
        updater: support.canInstall ? updater : null,
        support,
        isHostingActive: () => state.hosting,
    });
    const pushed = [];
    appUpdater.onStatus((status) => pushed.push(status));
    return { updater, appUpdater, state, pushed };
}

// --- Which builds can install in-app ---

test('Windows installs from the app when packaged', () => {
    const support = inAppInstallSupport({ platform: 'win32', isPackaged: true, env: {} });

    assert.deepEqual(support, { canInstall: true, unsupportedReason: null });
});

test('a Linux AppImage installs from the app; anything else on Linux does not', () => {
    const appImage = inAppInstallSupport({ platform: 'linux', isPackaged: true, env: { APPIMAGE: '/home/a/Flip.AppImage' } });
    const unpacked = inAppInstallSupport({ platform: 'linux', isPackaged: true, env: {} });

    assert.deepEqual(appImage, { canInstall: true, unsupportedReason: null });
    assert.deepEqual(unpacked, { canInstall: false, unsupportedReason: 'linux-not-appimage' });
});

test('macOS never installs from the app, because the build is not Developer ID signed', () => {
    const support = inAppInstallSupport({ platform: 'darwin', isPackaged: true, env: {} });

    assert.deepEqual(support, { canInstall: false, unsupportedReason: 'macos-unsigned' });
});

test('running from source never installs from the app, on any platform', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
        const support = inAppInstallSupport({ platform, isPackaged: false, env: { APPIMAGE: '/x' } });

        assert.deepEqual(support, { canInstall: false, unsupportedReason: 'running-from-source' });
    }
});

test('an unknown platform does not install from the app', () => {
    const support = inAppInstallSupport({ platform: 'freebsd', isPackaged: true, env: {} });

    assert.deepEqual(support, { canInstall: false, unsupportedReason: 'unsupported-platform' });
});

// --- Status ---

test('starts idle, and only downloads when asked', () => {
    const { updater, appUpdater } = setup();

    assert.deepEqual(appUpdater.getStatus(), {
        canInstall: true,
        unsupportedReason: null,
        phase: 'idle',
        percent: null,
        error: null,
    });
    assert.equal(updater.autoDownload, false);
    assert.equal(updater.autoInstallOnAppQuit, true);
    assert.deepEqual(updater.calls, []);
});

test('an unsupported build reports why and has no updater', () => {
    const { appUpdater } = setup({ support: { canInstall: false, unsupportedReason: 'macos-unsigned' } });

    assert.deepEqual(appUpdater.getStatus(), {
        canInstall: false,
        unsupportedReason: 'macos-unsigned',
        phase: 'idle',
        percent: null,
        error: null,
    });
});

// --- Downloading ---

test('download checks, then downloads, pushing progress and then ready', async () => {
    const { updater, appUpdater, pushed } = setup();

    const result = await appUpdater.download();

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(updater.calls, ['check', 'download']);
    assert.deepEqual(pushed.map((status) => [status.phase, status.percent]), [
        ['downloading', 0],
        ['downloading', 42],
        ['ready', 100],
    ]);
    assert.equal(appUpdater.getStatus().phase, 'ready');
});

test('download is refused on a build that cannot install in-app', async () => {
    const { appUpdater, pushed } = setup({ support: { canInstall: false, unsupportedReason: 'macos-unsigned' } });

    const result = await appUpdater.download();

    assert.equal(result.ok, false);
    assert.match(result.error, /download page/);
    assert.deepEqual(pushed, []);
});

test('a second download while one runs or is ready does nothing', async () => {
    const { updater, appUpdater } = setup();
    /** @type {(result: unknown) => void} */
    let finishCheck = () => {};
    updater.checkForUpdates = () => {
        updater.calls.push('check');
        return new Promise((resolve) => {
            finishCheck = resolve;
        });
    };

    const first = appUpdater.download();
    const second = await appUpdater.download();
    finishCheck(updater.checkResult);
    await first;
    const third = await appUpdater.download();

    assert.deepEqual(second, { ok: true });
    assert.deepEqual(third, { ok: true });
    assert.deepEqual(updater.calls, ['check', 'download']);
});

test('a release without installers for this platform fails the download', async () => {
    const { updater, appUpdater } = setup();
    updater.checkResult = { isUpdateAvailable: false, updateInfo: { version: '1.2.3' } };

    const result = await appUpdater.download();

    assert.equal(result.ok, false);
    assert.equal(appUpdater.getStatus().phase, 'failed');
    assert.match(appUpdater.getStatus().error, /No update for this computer/);
    assert.deepEqual(updater.calls, ['check']);
});

test('a check that answers null (updater inactive) fails the download', async () => {
    const { updater, appUpdater } = setup();
    updater.checkResult = null;

    const result = await appUpdater.download();

    assert.equal(result.ok, false);
    assert.equal(appUpdater.getStatus().phase, 'failed');
});

test('a failed download reports the error and can be tried again', async () => {
    const { updater, appUpdater, pushed } = setup();
    updater.downloadError = new Error('net::ERR_INTERNET_DISCONNECTED');

    const failed = await appUpdater.download();

    assert.deepEqual(failed, { ok: false, error: 'net::ERR_INTERNET_DISCONNECTED' });
    assert.deepEqual(pushed.at(-1), {
        canInstall: true,
        unsupportedReason: null,
        phase: 'failed',
        percent: null,
        error: 'net::ERR_INTERNET_DISCONNECTED',
    });

    updater.downloadError = null;
    const retried = await appUpdater.download();

    assert.deepEqual(retried, { ok: true });
    assert.equal(appUpdater.getStatus().phase, 'ready');
});

test('a failed check reports its error', async () => {
    const { updater, appUpdater } = setup();
    updater.checkError = new Error('HttpError: 404');

    const result = await appUpdater.download();

    assert.deepEqual(result, { ok: false, error: 'HttpError: 404' });
});

test('an updater error outside a download does not throw or change the status', () => {
    const { updater, appUpdater, pushed } = setup();

    updater.emit('error', new Error('stray'));

    assert.equal(appUpdater.getStatus().phase, 'idle');
    assert.deepEqual(pushed, []);
});

// --- Installing ---

test('install restarts into the downloaded update while idle', async () => {
    const { updater, appUpdater } = setup();
    await appUpdater.download();

    const result = appUpdater.install();

    assert.deepEqual(result, { ok: true });
    assert.equal(updater.calls.at(-1), 'quitAndInstall');
});

test('install is refused while hosting, so players are not cut off', async () => {
    const { updater, appUpdater, state } = setup();
    await appUpdater.download();
    state.hosting = true;

    const result = appUpdater.install();

    assert.equal(result.ok, false);
    assert.match(result.error, /Stop hosting/);
    assert.equal(updater.calls.includes('quitAndInstall'), false);
});

test('install is refused before the update has downloaded', () => {
    const { updater, appUpdater } = setup();

    const result = appUpdater.install();

    assert.equal(result.ok, false);
    assert.match(result.error, /not downloaded/);
    assert.deepEqual(updater.calls, []);
});

test('onStatus returns an unsubscribe', async () => {
    const { appUpdater } = setup();
    const received = [];
    const unsubscribe = appUpdater.onStatus((status) => received.push(status));

    unsubscribe();
    await appUpdater.download();

    assert.deepEqual(received, []);
});
