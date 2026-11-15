// In-app updates (X90): downloads the new release with electron-updater and restarts into it,
// but only when the user asks. updateCheck.js still decides whether there is an update; this
// module only fetches and installs it.
//
// Only some builds can install themselves. Windows (NSIS, per-user) and the Linux AppImage can.
// macOS can't: Squirrel.Mac only accepts an update signed with the same Developer ID as the
// running app, and the build is only ad-hoc signed (decision 9). There, and when running from
// source, the banner keeps linking to the release page instead.

/**
 * Why this build can't install updates itself, or null when it can.
 * @typedef {'running-from-source' | 'macos-unsigned' | 'linux-not-appimage' | 'unsupported-platform'} UnsupportedReason
 */

/**
 * @typedef {object} InstallSupport
 * @property {boolean} canInstall
 * @property {UnsupportedReason | null} unsupportedReason
 */

/**
 * @typedef {'idle' | 'downloading' | 'ready' | 'failed'} UpdatePhase
 *
 * @typedef {object} UpdateStatus
 * @property {boolean} canInstall
 * @property {UnsupportedReason | null} unsupportedReason
 * @property {UpdatePhase} phase
 * @property {number | null} percent  0-100 while downloading, 100 when ready, otherwise null
 * @property {string | null} error    why the last download failed
 */

/**
 * The part of electron-updater's autoUpdater this module uses.
 * @typedef {object} Updater
 * @property {boolean} autoDownload
 * @property {boolean} autoInstallOnAppQuit
 * @property {() => Promise<{ isUpdateAvailable?: boolean } | null>} checkForUpdates
 * @property {() => Promise<unknown>} downloadUpdate
 * @property {() => void} quitAndInstall
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} on
 */

/** @typedef {{ ok: true } | { ok: false, error: string }} ActionResult */

// --- Which builds can install in-app -------------------------------------------------------

/**
 * @param {object} input
 * @param {string} input.platform  process.platform
 * @param {boolean} input.isPackaged  app.isPackaged
 * @param {Record<string, string | undefined>} input.env  process.env; an AppImage sets APPIMAGE
 * @returns {InstallSupport}
 */
export function inAppInstallSupport({ platform, isPackaged, env }) {
    if (!isPackaged) {
        return unsupported('running-from-source');
    }

    if (platform === 'win32') {
        return { canInstall: true, unsupportedReason: null };
    }
    if (platform === 'darwin') {
        return unsupported('macos-unsigned');
    }
    if (platform === 'linux') {
        // electron-updater replaces the AppImage file in place; any other Linux layout it can't.
        if (env.APPIMAGE) {
            return { canInstall: true, unsupportedReason: null };
        }
        return unsupported('linux-not-appimage');
    }
    return unsupported('unsupported-platform');
}

/** @param {UnsupportedReason} reason */
function unsupported(reason) {
    return { canInstall: false, unsupportedReason: reason };
}

// --- Updater -------------------------------------------------------------------------------

/** @param {unknown} error */
function messageOf(error) {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

/**
 * Wraps electron-updater so it downloads only when asked and installs only while not hosting.
 * @param {object} input
 * @param {Updater | null} input.updater  null when `support` says the build can't install
 * @param {InstallSupport} input.support
 * @param {() => boolean} input.isHostingActive  true while a restart would cut players off
 */
export function createAppUpdater({ updater, support, isHostingActive }) {
    /** @type {Set<(status: UpdateStatus) => void>} */
    const listeners = new Set();
    /** @type {{ phase: UpdatePhase, percent: number | null, error: string | null }} */
    let state = { phase: 'idle', percent: null, error: null };

    /** @returns {UpdateStatus} */
    function getStatus() {
        return { ...support, ...state };
    }

    /** @param {Partial<typeof state>} changes */
    function update(changes) {
        state = { ...state, ...changes };
        const status = getStatus();
        for (const listener of listeners) {
            listener(status);
        }
    }

    if (updater) {
        configure(updater, { update, getPhase: () => state.phase });
    }

    /** @returns {Promise<ActionResult>} */
    async function download() {
        if (!updater) {
            return { ok: false, error: 'This version updates from the download page.' };
        }
        // A download already running or finished is what the user asked for, so it's not an error.
        if (state.phase === 'downloading' || state.phase === 'ready') {
            return { ok: true };
        }

        update({ phase: 'downloading', percent: 0, error: null });
        try {
            await fetchUpdate(updater);
        } catch (error) {
            const message = messageOf(error);
            update({ phase: 'failed', percent: null, error: message });
            return { ok: false, error: message };
        }
        update({ phase: 'ready', percent: 100 });
        return { ok: true };
    }

    /** @returns {ActionResult} */
    function install() {
        if (!updater || state.phase !== 'ready') {
            return { ok: false, error: 'The update has not downloaded yet.' };
        }
        // Main refuses too, not just the disabled button: a restart would drop every player.
        if (isHostingActive()) {
            return { ok: false, error: 'Stop hosting before restarting to update.' };
        }

        updater.quitAndInstall();
        return { ok: true };
    }

    /**
     * @param {(status: UpdateStatus) => void} listener
     * @returns {() => void}
     */
    function onStatus(listener) {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }

    return { getStatus, download, install, onStatus };
}

/**
 * Turns off the automatic download, and pushes download progress.
 * @param {Updater} updater
 * @param {{ update: (changes: { percent: number }) => void, getPhase: () => UpdatePhase }} hooks
 */
function configure(updater, { update, getPhase }) {
    updater.autoDownload = false;
    // A downloaded update the user didn't restart for installs when they next quit.
    updater.autoInstallOnAppQuit = true;

    updater.on('download-progress', (/** @type {{ percent: number }} */ progress) => {
        if (getPhase() === 'downloading') {
            update({ percent: Math.round(progress.percent) });
        }
    });
    // Without a listener an 'error' event would throw. Download failures also reject
    // downloadUpdate(), which is where they're reported, so this only keeps the app alive.
    updater.on('error', (/** @type {unknown} */ error) => {
        console.warn(`[updater] ${messageOf(error)}`);
    });
}

/**
 * electron-updater needs its own check before it can download. That check reads latest*.yml
 * from the release, which can disagree with updateCheck.js, e.g. a release without an installer
 * for this platform.
 * @param {Updater} updater
 */
async function fetchUpdate(updater) {
    const result = await updater.checkForUpdates();
    if (!result || !result.isUpdateAvailable) {
        throw new Error('No update for this computer was found in the latest release.');
    }
    await updater.downloadUpdate();
}
