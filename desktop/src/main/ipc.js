// The main-process side of the launcher's IPC bridge (window.launcher, see
// src/shared/launcherBridge.d.ts). The renderer is treated as untrusted: every request must
// come from the launcher window and every payload is checked here before it reaches the
// session, the settings file or the operating system.
//
// Error convention: a malformed payload rejects (a TypeError), because only a bug or a hostile
// page sends one. A request that is fine but not possible right now (resetting data while
// hosting, opening the game with no link yet) resolves `{ ok: false, error }` for the UI to show.
import ipcChannels from '../shared/ipcChannels.cjs';

const { INVOKE_CHANNELS, EVENT_CHANNELS } = ipcChannels;

/** Same pause as `npm run share`: lets a brand-new hostname's DNS record propagate. */
export const OPEN_GAME_DELAY_MS = 3_000;

const MAX_GEMINI_KEY_LENGTH = 200;
const MAX_GEMINI_MODEL_LENGTH = 100;
const MAX_URL_LENGTH = 2048;
// Model ids such as "gemini-3.5-flash-lite": letters, digits, dots, dashes and underscores.
const GEMINI_MODEL_PATTERN = /^[A-Za-z0-9._-]*$/;
const SETTING_KEYS = new Set(['geminiApiKey', 'geminiModel']);
// Where the launcher's own links point: the Gemini API key page and the release pages.
const EXTERNAL_HOSTS = new Set(['aistudio.google.com', 'github.com']);

/**
 * @typedef {object} IpcDependencies
 * @property {{ handle(channel: string, handler: (event: any, ...args: any[]) => unknown): void,
 *   removeHandler(channel: string): void }} ipcMain
 * @property {{ start(): Promise<any>, stop(): Promise<void>, retry(): Promise<any>, getState(): any,
 *   on(event: string, listener: (...args: any[]) => void): unknown,
 *   removeListener(event: string, listener: (...args: any[]) => void): unknown }} session
 * @property {{ load(): any, save(changes: object): any, resetData(): void }} settingsStore
 * @property {{ isOnBattery(): boolean,
 *   onBatteryChange(listener: (onBattery: boolean) => void): () => void }} keepAwake
 * @property {string} appVersion
 * @property {(key: string) => Promise<string>} checkGeminiKey
 * @property {() => Promise<object>} checkForUpdate  bound to the app version by the caller
 * @property {(url: string) => Promise<void>} openExternal  shell.openExternal
 * @property {(filePath: string) => Promise<string>} openPath  shell.openPath: '' on success,
 *   otherwise the error
 * @property {Record<string, string>} licensePaths  the About section's files by LicenseName
 * @property {(channel: string, payload: unknown) => void} send  pushes to the launcher window
 * @property {(event: any) => boolean} isTrustedSender  true only for the launcher window's page
 * @property {{ isVisible(): boolean, onShown(listener: () => void): () => void }} windowVisibility
 *   whether the launcher window is on screen (not minimised or hidden), and its show/restore
 * @property {number} [openGameDelayMs]
 * @property {() => number} [now]
 * @property {(ms: number) => Promise<void>} [sleep]
 */

// --- Payload checks ------------------------------------------------------------------------

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} maxLength
 * @returns {string}
 */
function requireString(value, name, maxLength) {
    if (typeof value !== 'string') {
        throw new TypeError(`${name} must be a string`);
    }
    if (value.length > maxLength) {
        throw new TypeError(`${name} is longer than ${maxLength} characters`);
    }
    return value;
}

/**
 * Accepts only `{ geminiApiKey?, geminiModel? }` with sensible strings.
 * @param {unknown} changes
 * @returns {{ geminiApiKey?: string, geminiModel?: string }}
 */
function checkSettingsChanges(changes) {
    if (!isPlainObject(changes)) {
        throw new TypeError('Settings changes must be an object');
    }
    for (const key of Object.keys(changes)) {
        if (!SETTING_KEYS.has(key)) {
            throw new TypeError(`Unknown setting: ${key}`);
        }
    }

    /** @type {{ geminiApiKey?: string, geminiModel?: string }} */
    const checked = {};
    if ('geminiApiKey' in changes) {
        checked.geminiApiKey = requireString(changes.geminiApiKey, 'geminiApiKey', MAX_GEMINI_KEY_LENGTH);
    }
    if ('geminiModel' in changes) {
        const model = requireString(changes.geminiModel, 'geminiModel', MAX_GEMINI_MODEL_LENGTH);
        if (!GEMINI_MODEL_PATTERN.test(model.trim())) {
            throw new TypeError('geminiModel may only hold letters, digits, dots, dashes and underscores');
        }
        checked.geminiModel = model;
    }
    return checked;
}

/**
 * @param {unknown} key
 * @returns {string}
 */
function checkGeminiKeyPayload(key) {
    const text = requireString(key, 'key', MAX_GEMINI_KEY_LENGTH);
    if (text.trim() === '') {
        throw new TypeError('key must not be blank');
    }
    return text;
}

/**
 * The host of the live tunnel URL, or null while there is none.
 * @param {string | null} tunnelUrl
 * @returns {string | null}
 */
function hostOf(tunnelUrl) {
    if (tunnelUrl === null) {
        return null;
    }
    return new URL(tunnelUrl).hostname;
}

/**
 * Only https links to the hosts the launcher links to leave the app: the Gemini key page, the
 * GitHub release page and the current game link. That keeps file:, javascript:, custom
 * protocol handlers and arbitrary sites out of the renderer's reach.
 * @param {unknown} url
 * @param {string | null} tunnelUrl  the session's live tunnel URL
 * @returns {string}
 */
function checkExternalUrl(url, tunnelUrl) {
    const text = requireString(url, 'url', MAX_URL_LENGTH);
    let parsed;
    try {
        parsed = new URL(text);
    } catch {
        throw new TypeError('url is not a valid URL');
    }
    if (parsed.protocol !== 'https:') {
        throw new TypeError('Only https links can be opened');
    }

    const isKnownHost = EXTERNAL_HOSTS.has(parsed.hostname) || parsed.hostname === hostOf(tunnelUrl);
    if (!isKnownHost) {
        throw new TypeError(`Links to ${parsed.hostname} can't be opened`);
    }
    return parsed.href;
}

// --- Sender check --------------------------------------------------------------------------

/**
 * True when `frameUrl` is the launcher page: the dev server's origin when running with one,
 * otherwise the built index.html (any #route on it is fine).
 * @param {string} frameUrl
 * @param {{ rendererFileUrl: string, rendererDevUrl?: string }} page
 */
function isLauncherPage(frameUrl, page) {
    let parsed;
    try {
        parsed = new URL(frameUrl);
    } catch {
        return false;
    }

    if (page.rendererDevUrl) {
        return parsed.origin === new URL(page.rendererDevUrl).origin;
    }
    parsed.hash = '';
    parsed.search = '';
    return parsed.href === page.rendererFileUrl;
}

/**
 * Builds the isTrustedSender check: true only for requests from the launcher window's top
 * frame while it shows the launcher page.
 * @param {object} input
 * @param {() => unknown} input.getWebContents  the launcher window's webContents, or null once closed
 * @param {string} input.rendererFileUrl  file:// URL of the built index.html
 * @param {string} [input.rendererDevUrl]  the renderer's Vite dev server, when running with one
 * @returns {(event: any) => boolean}
 */
export function createSenderCheck({ getWebContents, rendererFileUrl, rendererDevUrl }) {
    return (event) => {
        const webContents = getWebContents();
        const isLauncherWindow = webContents !== null && event.sender === webContents;
        // senderFrame is null once the frame has navigated away or been destroyed.
        const frame = event.senderFrame;
        const isTopFrame = frame !== null && frame !== undefined && frame === event.sender.mainFrame;

        return isLauncherWindow
            && isTopFrame
            && isLauncherPage(frame.url, { rendererFileUrl, rendererDevUrl });
    };
}

// --- Open game timing ----------------------------------------------------------------------

/**
 * Remembers when the current tunnel URL first appeared, so Open game waits only for the part
 * of the DNS delay that hasn't passed yet.
 * @param {() => number} now
 */
function createUrlAgeTracker(now) {
    /** @type {string | null} */
    let url = null;
    let seenAt = 0;

    return {
        /** @param {string | null} nextUrl */
        observe(nextUrl) {
            if (nextUrl !== null && nextUrl !== url) {
                seenAt = now();
            }
            url = nextUrl;
        },
        /** @param {number} delayMs */
        remainingDelay(delayMs) {
            return Math.max(0, delayMs - (now() - seenAt));
        },
    };
}

/** @param {number} ms */
function sleepFor(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Room stats ----------------------------------------------------------------------------

/**
 * The server's latest room stats (X66), kept here so the renderer can be skipped while the
 * window is hidden and catch up in one go when it's shown, or when the page reloads.
 * @typedef {{ latest: unknown }} RoomStatsCache
 */

// --- Handlers ------------------------------------------------------------------------------

/**
 * The request handlers by channel name, each taking the renderer's (already untrusted)
 * arguments.
 * @param {IpcDependencies} deps
 * @param {ReturnType<typeof createUrlAgeTracker>} urlAge
 * @param {RoomStatsCache} roomStats
 * @returns {Record<string, (...args: unknown[]) => unknown>}
 */
function createHandlers(deps, urlAge, roomStats) {
    const { session, settingsStore, keepAwake } = deps;
    const openGameDelayMs = deps.openGameDelayMs ?? OPEN_GAME_DELAY_MS;
    const sleep = deps.sleep ?? sleepFor;

    async function stop() {
        await session.stop();
        return session.getState();
    }

    function resetData() {
        const { status } = session.getState();
        // Still refused: a teardown that failed also ends in 'failed', so a child may still hold
        // the database. Dismissing the error (stop(), which moves failed to idle) comes first.
        if (status === 'failed') {
            return { ok: false, error: 'Hosting failed. Dismiss the error first, then reset data.' };
        }
        if (status !== 'idle') {
            return { ok: false, error: 'Stop hosting before resetting data.' };
        }

        try {
            settingsStore.resetData();
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        return { ok: true };
    }

    async function openGame() {
        const url = session.getState().url;
        if (url === null) {
            return { ok: false, error: 'Not hosting yet: there is no game link to open.' };
        }

        const waitMs = urlAge.remainingDelay(openGameDelayMs);
        if (waitMs > 0) {
            await sleep(waitMs);
        }

        // The tunnel may have restarted during the wait; never open a dead link.
        if (session.getState().url !== url) {
            return { ok: false, error: 'The game link changed while waiting. Try again.' };
        }
        await deps.openExternal(url);
        return { ok: true };
    }

    /** Opens one of the About section's licence files in the system's text viewer. */
    async function openLicense(/** @type {unknown} */ name) {
        if (typeof name !== 'string' || !Object.hasOwn(deps.licensePaths, name)) {
            throw new TypeError('name must be a known licence');
        }

        const error = await deps.openPath(deps.licensePaths[name]);
        if (error) {
            return { ok: false, error: `Couldn't open the file: ${error}` };
        }
        return { ok: true };
    }

    return {
        [INVOKE_CHANNELS.start]: () => session.start(),
        [INVOKE_CHANNELS.stop]: stop,
        [INVOKE_CHANNELS.retry]: () => session.retry(),
        [INVOKE_CHANNELS.getState]: () => session.getState(),
        [INVOKE_CHANNELS.getRoomStats]: () => roomStats.latest,
        [INVOKE_CHANNELS.getSettings]: () => settingsStore.load(),
        [INVOKE_CHANNELS.saveSettings]: (changes) => settingsStore.save(checkSettingsChanges(changes)),
        [INVOKE_CHANNELS.validateGeminiKey]: (key) => deps.checkGeminiKey(checkGeminiKeyPayload(key)),
        [INVOKE_CHANNELS.resetData]: resetData,
        [INVOKE_CHANNELS.checkForUpdate]: () => deps.checkForUpdate(),
        [INVOKE_CHANNELS.openExternal]: async (url) => {
            await deps.openExternal(checkExternalUrl(url, session.getState().url));
        },
        [INVOKE_CHANNELS.openGame]: openGame,
        [INVOKE_CHANNELS.openLicense]: openLicense,
        [INVOKE_CHANNELS.getPowerStatus]: () => ({ onBattery: keepAwake.isOnBattery() }),
        [INVOKE_CHANNELS.getAppInfo]: () => ({ version: deps.appVersion }),
    };
}

/**
 * Wraps a handler so it runs only for the launcher window, and always answers with a promise.
 * @param {(event: any) => boolean} isTrustedSender
 * @param {(...args: unknown[]) => unknown} handler
 */
function guardSender(isTrustedSender, handler) {
    return async (/** @type {any} */ event, /** @type {unknown[]} */ ...args) => {
        if (!isTrustedSender(event)) {
            throw new Error('Untrusted IPC sender');
        }
        return handler(...args);
    };
}

// --- Registration --------------------------------------------------------------------------

/**
 * Pushes session and power changes to the renderer. Room stats are cached, and sent only while
 * the window is visible; showing it sends the latest once (X66).
 * @param {IpcDependencies} deps
 * @param {ReturnType<typeof createUrlAgeTracker>} urlAge
 * @param {RoomStatsCache} roomStats
 * @returns {() => void} stops forwarding
 */
function forwardEvents(deps, urlAge, roomStats) {
    const { session, keepAwake, send, windowVisibility } = deps;

    const onState = (/** @type {{ url: string | null }} */ snapshot) => {
        urlAge.observe(snapshot.url);
        send(EVENT_CHANNELS.state, snapshot);
    };
    const onUrlChanged = (/** @type {unknown} */ change) => send(EVENT_CHANNELS.urlChanged, change);
    session.on('state', onState);
    session.on('url-changed', onUrlChanged);
    const stopPower = keepAwake.onBatteryChange((onBattery) => {
        send(EVENT_CHANNELS.powerStatus, { onBattery });
    });

    const onRoomStats = (/** @type {unknown} */ stats) => {
        roomStats.latest = stats;
        if (windowVisibility.isVisible()) {
            send(EVENT_CHANNELS.roomStats, stats);
        }
    };
    session.on('room-stats', onRoomStats);
    const stopShown = windowVisibility.onShown(() => send(EVENT_CHANNELS.roomStats, roomStats.latest));

    return () => {
        session.removeListener('state', onState);
        session.removeListener('url-changed', onUrlChanged);
        session.removeListener('room-stats', onRoomStats);
        stopPower();
        stopShown();
    };
}

/**
 * Registers every launcher IPC handler and starts pushing events to the renderer.
 * @param {IpcDependencies} deps
 * @returns {() => void} removes the handlers and stops the events
 */
export function registerIpcHandlers(deps) {
    const urlAge = createUrlAgeTracker(deps.now ?? Date.now);
    urlAge.observe(deps.session.getState().url);

    /** @type {RoomStatsCache} */
    const roomStats = { latest: null };

    const handlers = createHandlers(deps, urlAge, roomStats);
    for (const [channel, handler] of Object.entries(handlers)) {
        deps.ipcMain.handle(channel, guardSender(deps.isTrustedSender, handler));
    }
    const stopForwarding = forwardEvents(deps, urlAge, roomStats);

    return () => {
        for (const channel of Object.keys(handlers)) {
            deps.ipcMain.removeHandler(channel);
        }
        stopForwarding();
    };
}
