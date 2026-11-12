// The launcher's Electron entry point: thin glue that builds the real dependencies (Electron
// APIs, child_process, fetch, paths) and hands them to the tested modules. Excluded from
// coverage; anything with logic belongs in a module beside it.
import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    Menu,
    nativeTheme,
    powerMonitor,
    powerSaveBlocker,
    safeStorage,
    shell,
    utilityProcess,
} from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveAppVersion } from './appVersion.js';
import { resolveCloudflaredPath, resolveLicensePaths, resolveServerPaths } from './binaries.js';
import { checkGeminiKey } from './geminiKey.js';
import { createHostingSession, installQuitCleanup } from './hostingSession.js';
import { createSenderCheck, registerIpcHandlers } from './ipc.js';
import { createKeepAwake } from './keepAwake.js';
import { isPermissionAllowed } from './pagePermissions.js';
import { pickPort } from './portPicker.js';
import { createServerProcess } from './serverProcess.js';
import { createSettingsStore } from './settingsStore.js';
import { createTunnelProcess } from './tunnelProcess.js';
import { checkForUpdate } from './updateCheck.js';

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PRELOAD_PATH = path.join(DESKTOP_ROOT, 'src', 'preload', 'preload.cjs');
const RENDERER_FILE = path.join(DESKTOP_ROOT, 'dist-renderer', 'index.html');
// The site favicon as a PNG (scripts/icon.mjs). Packaged Windows and macOS builds take their icon
// from the executable; this covers running from source and Linux.
const ICON_PATH = path.join(DESKTOP_ROOT, 'build-resources', 'icon.png');
// Matches .launcher-titlebar's height in launcher.css.
const TITLE_BAR_HEIGHT = 36;
// Running from source with the renderer's Vite dev server, e.g. http://localhost:5174.
const RENDERER_DEV_URL = process.env.FLIP7_LAUNCHER_RENDERER_URL;

// Shown until the renderer is built (`desktop/dist-renderer`).
const PLACEHOLDER_HTML = `<!doctype html><meta charset="utf-8"><title>Flip Showdown</title>
<body style="font-family:sans-serif;padding:24px">
<h2>Flip Showdown</h2><p>The launcher UI is not built yet.</p></body>`;

/** @type {BrowserWindow | null} */
let mainWindow = null;

// --- Hosting -------------------------------------------------------------------------------

/**
 * Adapts Electron's utilityProcess.fork to the fork contract serverProcess expects.
 * @param {string} modulePath
 * @param {string[]} args
 * @param {{ env: Record<string, string | undefined>, cwd: string, stdio: 'pipe' }} options
 */
function forkUtility(modulePath, args, options) {
    return utilityProcess.fork(modulePath, args, {
        env: options.env,
        cwd: options.cwd,
        stdio: options.stdio,
        serviceName: 'Flip Showdown server',
    });
}

/** Builds the hosting session and everything it runs, from the app's paths and settings. */
function createHosting() {
    const appDataDir = app.getPath('userData');
    const dataDir = path.join(appDataDir, 'data');
    const layout = { isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, desktopRoot: DESKTOP_ROOT };
    const serverPaths = resolveServerPaths(layout);
    const cloudflaredPath = resolveCloudflaredPath({ ...layout, platform: process.platform, arch: process.arch });

    // safeStorage works only once the app is ready; createHosting runs after that.
    const settingsStore = createSettingsStore({
        appDataDir,
        gameDataDir: dataDir,
        cipher: safeStorage,
        onWarning: (message) => console.warn(`[launcher] ${message}`),
    });
    const keepAwake = createKeepAwake({ powerSaveBlocker, powerMonitor });
    const session = createHostingSession({
        pickPort: () => pickPort(),
        // Settings are read per start, so a key saved in the launcher applies to the next start.
        createServer: ({ port }) => {
            const settings = settingsStore.load();
            // The secret now comes from the encrypted settings, so a plain copy the server once wrote
            // to the data folder is only a leak.
            settingsStore.removePlainSessionSecretFile();
            return createServerProcess({
                fork: forkUtility,
                fetch: globalThis.fetch,
                ...serverPaths,
                dataDir,
                port,
                sessionSecret: settingsStore.getSessionSecret(),
                geminiApiKey: settings.geminiApiKey,
                geminiModel: settings.geminiModel,
            });
        },
        createTunnel: ({ port }) => createTunnelProcess({ spawn, binaryPath: cloudflaredPath, port }),
        keepAwake,
    });
    session.on('log', ({ source, line }) => console.log(`[${source}] ${line}`));
    session.on('state', (snapshot) => console.log(`[launcher] ${snapshot.status}`));

    return { session, settingsStore, keepAwake };
}

/** @param {{ status: string }} snapshot */
function isHostingActive(snapshot) {
    return snapshot.status !== 'idle' && snapshot.status !== 'failed';
}

/** The decision 15 prompt. Resolves true when the user chose to stop hosting and quit. */
async function confirmQuit() {
    const options = {
        type: /** @type {const} */ ('question'),
        buttons: ['Stop hosting and quit', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'Stop hosting and quit?',
        detail: 'Players on the current link will be disconnected.',
    };
    let result;
    if (mainWindow && !mainWindow.isDestroyed()) {
        result = await dialog.showMessageBox(mainWindow, options);
    } else {
        result = await dialog.showMessageBox(options);
    }
    return result.response === 0;
}

// --- Window --------------------------------------------------------------------------------

/** @param {BrowserWindow} window */
async function loadRenderer(window) {
    if (RENDERER_DEV_URL) {
        await window.loadURL(RENDERER_DEV_URL);
        return;
    }
    if (fs.existsSync(RENDERER_FILE)) {
        await window.loadFile(RENDERER_FILE);
        return;
    }
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PLACEHOLDER_HTML)}`);
}

/**
 * Locks the page in: it can't navigate away, open windows or get any permission (camera,
 * notifications and so on) beyond clipboard writes; see pagePermissions.js. Links go through
 * window.launcher.openExternal instead.
 * @param {BrowserWindow} window
 */
function lockDownPage(window) {
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
        callback(isPermissionAllowed(permission));
    });
    window.webContents.session.setPermissionCheckHandler((_webContents, permission) => {
        return isPermissionAllowed(permission);
    });
}

/**
 * The launcher window, sandboxed and isolated from Node; see lockDownPage for the rest.
 * @param {{ getState(): { status: string } }} session
 */
function createWindow(session) {
    // The page is always the dark Classic look (X65), so the title bar goes dark too and the
    // window shows that colour, not a white flash, while the page loads.
    nativeTheme.themeSource = 'dark';
    const window = new BrowserWindow({
        width: 520,
        height: 760,
        minWidth: 400,
        minHeight: 560,
        title: 'Flip Showdown',
        icon: ICON_PATH,
        backgroundColor: '#1e1b4b',
        // No native title bar: the page's gradient runs to the top edge and draws its own title
        // strip (.launcher-titlebar). Windows and Linux overlay their window buttons on it, in
        // white on clear; macOS keeps its traffic lights, centred in the same 36px strip.
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#00000000', symbolColor: '#ffffff', height: TITLE_BAR_HEIGHT },
        trafficLightPosition: { x: 14, y: 12 },
        webPreferences: {
            preload: PRELOAD_PATH,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    lockDownPage(window);

    // Closing while hosting goes through app.quit(), so the window's X, Cmd+Q and the menu all
    // share the one "Stop hosting and quit?" prompt in installQuitCleanup. Once the session is
    // stopped the window closes normally.
    window.on('close', (event) => {
        if (isHostingActive(session.getState())) {
            event.preventDefault();
            app.quit();
        }
    });
    window.on('closed', () => {
        mainWindow = null;
    });
    // Room stats skip the renderer while the window is hidden; these let it catch up (X66).
    window.on('show', notifyWindowShown);
    window.on('restore', notifyWindowShown);

    loadRenderer(window).catch((error) => console.error('Loading the launcher page failed:', error));
    return window;
}

function getLauncherWebContents() {
    if (mainWindow === null || mainWindow.isDestroyed()) {
        return null;
    }
    return mainWindow.webContents;
}

/** @type {Set<() => void>} */
const windowShownListeners = new Set();

function notifyWindowShown() {
    for (const listener of windowShownListeners) {
        listener();
    }
}

/** For ipc.js: whether the launcher window is on screen, and when it comes back. */
const windowVisibility = {
    isVisible() {
        return mainWindow !== null
            && !mainWindow.isDestroyed()
            && mainWindow.isVisible()
            && !mainWindow.isMinimized();
    },
    /** @param {() => void} listener */
    onShown(listener) {
        windowShownListeners.add(listener);
        return () => {
            windowShownListeners.delete(listener);
        };
    },
};

/**
 * @param {string} channel
 * @param {unknown} payload
 */
function sendToRenderer(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, payload);
    }
}

// --- Lifecycle -----------------------------------------------------------------------------

/** The root package.json, or null when it isn't there (packaged builds don't ship it). */
function readRootPackageJson() {
    try {
        return JSON.parse(fs.readFileSync(path.join(DESKTOP_ROOT, '..', 'package.json'), 'utf8'));
    } catch {
        return null;
    }
}

function startLauncher() {
    const { session, settingsStore, keepAwake } = createHosting();
    const appVersion = resolveAppVersion({
        isPackaged: app.isPackaged,
        appVersion: app.getVersion(),
        rootPackageJson: app.isPackaged ? null : readRootPackageJson(),
    });

    installQuitCleanup({ session, app, signalTarget: process, confirmQuit });

    // No File/Edit/View/Window bar on Windows and Linux. macOS keeps its default menu: it sits in
    // the system bar, not the window, and carries Cmd+Q and the copy/paste shortcuts.
    if (process.platform !== 'darwin') {
        Menu.setApplicationMenu(null);
    }

    registerIpcHandlers({
        ipcMain,
        session,
        settingsStore,
        keepAwake,
        appVersion,
        checkGeminiKey: (key) => checkGeminiKey(key),
        checkForUpdate: () => checkForUpdate({ currentVersion: appVersion }),
        openExternal: (url) => shell.openExternal(url),
        openPath: (filePath) => shell.openPath(filePath),
        licensePaths: resolveLicensePaths({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, desktopRoot: DESKTOP_ROOT }),
        send: sendToRenderer,
        windowVisibility,
        isTrustedSender: createSenderCheck({
            getWebContents: getLauncherWebContents,
            rendererFileUrl: pathToFileURL(RENDERER_FILE).href,
            rendererDevUrl: RENDERER_DEV_URL,
        }),
    });

    mainWindow = createWindow(session);
}

function focusMainWindow() {
    if (!mainWindow) {
        return;
    }
    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }
    mainWindow.focus();
}

// One launcher per user: a second copy would fight over the port and the data folder.
if (app.requestSingleInstanceLock()) {
    app.on('second-instance', focusMainWindow);
    app.whenReady().then(startLauncher).catch((error) => {
        console.error('Starting the launcher failed:', error);
        app.exit(1);
    });
} else {
    app.quit();
}
