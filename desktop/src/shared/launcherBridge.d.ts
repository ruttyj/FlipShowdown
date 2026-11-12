// The launcher page's view of the main process: `window.launcher`, exposed by
// src/preload/preload.cjs and served by src/main/ipc.js. Renderer tests type their fake with it.
//
// Errors: a malformed argument rejects (a bug, not a user error). A request that is valid but not
// possible right now resolves an ActionResult with ok: false and a message for the UI.

export type HostingStatus =
    | 'idle'
    | 'starting-server'
    | 'starting-tunnel'
    | 'hosting'
    | 'tunnel-restarting'
    | 'stopping'
    | 'failed';

/** The tunnel restart the session is waiting to make. */
export interface RetryInfo {
    /** 1-based */
    attempt: number;
    maxRetries: number;
    delayMs: number;
}

export interface HostingSnapshot {
    status: HostingStatus;
    port: number | null;
    /** The live public URL; null while the tunnel is down. */
    url: string | null;
    /** The URL before the last change, for the "URL changed, rescan" banner. */
    previousUrl: string | null;
    /** Why the session failed. */
    error: string | null;
    retry: RetryInfo | null;
    /** The last output lines, oldest first. */
    serverLog: string[];
    tunnelLog: string[];
}

export interface UrlChange {
    previousUrl: string | null;
    url: string;
}

/** One room in play: someone in it is online and it isn't closed (X66). */
export interface RoomStat {
    code: string;
    status: 'waiting' | 'playing' | 'finished';
    round: number;
    maxScore: number;
    /** The room's players who are online. */
    online: number;
    /** Everyone in the room. */
    players: number;
}

/** Who is playing on the running server, pushed at most once a second (X66). */
export interface RoomStats {
    /** Distinct people online in a room; two tabs or devices count once. */
    playersOnline: number;
    roomsLive: number;
    /** Busiest first. */
    rooms: RoomStat[];
}

export interface Settings {
    /** '' when the user skipped the key. */
    geminiApiKey: string;
    geminiModel: string;
    /** How the key is kept on disk: encrypted by the OS (DPAPI, Keychain, keyring), or as plain
     * text on a system without a keyring. Read-only. */
    secretStorage: SecretStorage;
}

export type SecretStorage = 'encrypted' | 'plain-text';

/** At most 200 characters for the key and 100 for the model ([A-Za-z0-9._-]). */
export type SettingsChanges = Partial<Pick<Settings, 'geminiApiKey' | 'geminiModel'>>;

export type GeminiKeyStatus = 'valid' | 'invalid' | 'unknown';

export interface UpdateResult {
    updateAvailable: boolean;
    /** Without the "v", e.g. "1.2.0". */
    latestVersion: string | null;
    /** The release page on github.com. */
    url: string | null;
}

export type ActionResult = { ok: true } | { ok: false; error: string };

export interface PowerStatus {
    onBattery: boolean;
}

export interface AppInfo {
    version: string;
}

/** The About section's files: the app's LICENSE, THIRD_PARTY_NOTICES.txt, cloudflared's licence. */
export type LicenseName = 'app' | 'third-party' | 'cloudflared';

export type Unsubscribe = () => void;

export interface LauncherBridge {
    /** Resolves once hosting, failed or stopped; never rejects (failures are in the snapshot). */
    start(): Promise<HostingSnapshot>;
    /** Stops the tunnel, then the server; resolves with the idle snapshot. */
    stop(): Promise<HostingSnapshot>;
    /** The error screen's Retry: restarts from 'failed', does nothing otherwise. */
    retry(): Promise<HostingSnapshot>;
    getState(): Promise<HostingSnapshot>;
    onState(callback: (snapshot: HostingSnapshot) => void): Unsubscribe;
    onUrlChanged(callback: (change: UrlChange) => void): Unsubscribe;
    /** The latest stats while the server runs; null otherwise. */
    getRoomStats(): Promise<RoomStats | null>;
    /** Pushed only while the window is visible, and once more when it's shown again. */
    onRoomStats(callback: (stats: RoomStats | null) => void): Unsubscribe;

    getSettings(): Promise<Settings>;
    /** Merges the changes and resolves with the saved settings. Used by the next start. */
    saveSettings(changes: SettingsChanges): Promise<Settings>;
    validateGeminiKey(key: string): Promise<GeminiKeyStatus>;
    /** Deletes the game database. Only while idle; otherwise resolves ok: false. */
    resetData(): Promise<ActionResult>;
    checkForUpdate(): Promise<UpdateResult>;

    /** Opens an https:// link to aistudio.google.com, github.com or the current game link in
     * the default browser; anything else rejects. */
    openExternal(url: string): Promise<void>;
    /** Opens the tunnel URL in the default browser, first waiting out the DNS delay (about
     * 3 s after the URL appeared). ok: false when there is no URL or it changed meanwhile. */
    openGame(): Promise<ActionResult>;
    /** Opens a licence file in the system's viewer; ok: false when it can't (e.g. missing). */
    openLicense(name: LicenseName): Promise<ActionResult>;

    getPowerStatus(): Promise<PowerStatus>;
    onPowerStatus(callback: (status: PowerStatus) => void): Unsubscribe;
    getAppInfo(): Promise<AppInfo>;
}

declare global {
    interface Window {
        launcher: LauncherBridge;
    }
}
