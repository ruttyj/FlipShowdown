// A fake window.launcher for the launcher UI tests. Every method is a vi.fn spy with a sensible
// default, and the push events (state, URL changed, power, room stats) are fired by the test with
// emitState, emitUrlChanged, emitPowerStatus and emitRoomStats. Override one method with
// `launcher.start.mockImplementation`.
//
// Usage:
//   const fake = createFakeLauncher({ snapshot: { status: 'hosting', url: TUNNEL_URL } });
//   render(<LauncherApp launcher={fake.launcher} />);
//   act(() => fake.emitState({ status: 'failed', error: 'Tunnel exited' }));
import { act } from '@testing-library/react';
import { vi } from 'vitest';

/** @typedef {import('../../src/shared/launcherBridge').LauncherBridge} LauncherBridge */
/** @typedef {import('../../src/shared/launcherBridge').HostingSnapshot} HostingSnapshot */
/** @typedef {import('../../src/shared/launcherBridge').Settings} Settings */
/** @typedef {import('../../src/shared/launcherBridge').PowerStatus} PowerStatus */
/** @typedef {import('../../src/shared/launcherBridge').UrlChange} UrlChange */
/** @typedef {import('../../src/shared/launcherBridge').RoomStats} RoomStats */

export const TUNNEL_URL = 'https://brave-otter-lamp.trycloudflare.com';
export const NEW_TUNNEL_URL = 'https://quiet-river-moon.trycloudflare.com';

/** @type {Settings} */
const DEFAULT_SETTINGS = { geminiApiKey: '', geminiModel: 'gemini-3.5-flash-lite', secretStorage: 'encrypted' };

/** The statuses a start or retry resolves at in the real bridge. */
const SETTLED_STATUSES = new Set(['hosting', 'failed', 'idle']);

/**
 * @param {Partial<HostingSnapshot>} [overrides]
 * @returns {HostingSnapshot}
 */
export function makeSnapshot(overrides = {}) {
    return {
        status: 'idle',
        port: null,
        url: null,
        previousUrl: null,
        error: null,
        retry: null,
        serverLog: [],
        tunnelLog: [],
        ...overrides,
    };
}

/**
 * @param {{ snapshot?: Partial<HostingSnapshot>, settings?: Partial<Settings>,
 *   power?: PowerStatus, version?: string, roomStats?: RoomStats | null }} [options]
 */
export function createFakeLauncher(options = {}) {
    let snapshot = makeSnapshot(options.snapshot);
    const listeners = {
        state: new Set(),
        urlChanged: new Set(),
        power: new Set(),
        roomStats: new Set(),
    };

    function subscribe(set, callback) {
        set.add(callback);
        return () => {
            set.delete(callback);
        };
    }

    // Like the real bridge, start() and retry() resolve only once the session settles: when a
    // pushed state is hosting, failed or idle (stopped). Each entry resolves one pending call.
    /** @type {Array<(settled: HostingSnapshot) => void>} */
    let pendingSettles = [];

    function untilSettled() {
        return new Promise((resolve) => {
            pendingSettles.push(resolve);
        });
    }

    function settlePending() {
        if (!SETTLED_STATUSES.has(snapshot.status)) {
            return;
        }
        for (const resolve of pendingSettles) {
            resolve(snapshot);
        }
        pendingSettles = [];
    }

    /** @type {LauncherBridge & Record<string, import('vitest').Mock>} */
    const launcher = {
        start: vi.fn(untilSettled),
        stop: vi.fn(async () => snapshot),
        retry: vi.fn(untilSettled),
        getState: vi.fn(async () => snapshot),
        onState: vi.fn((callback) => subscribe(listeners.state, callback)),
        onUrlChanged: vi.fn((callback) => subscribe(listeners.urlChanged, callback)),
        getRoomStats: vi.fn(async () => options.roomStats ?? null),
        onRoomStats: vi.fn((callback) => subscribe(listeners.roomStats, callback)),
        getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, ...options.settings })),
        saveSettings: vi.fn(async (changes) => ({ ...DEFAULT_SETTINGS, ...options.settings, ...changes })),
        validateGeminiKey: vi.fn(async () => 'valid'),
        resetData: vi.fn(async () => ({ ok: true })),
        checkForUpdate: vi.fn(async () => ({ updateAvailable: false, latestVersion: null, url: null })),
        openExternal: vi.fn(async () => {}),
        openGame: vi.fn(async () => ({ ok: true })),
        openLicense: vi.fn(async () => options.openLicenseResult ?? { ok: true }),
        getPowerStatus: vi.fn(async () => options.power ?? { onBattery: false }),
        onPowerStatus: vi.fn((callback) => subscribe(listeners.power, callback)),
        getAppInfo: vi.fn(async () => ({ version: options.version ?? '1.0.0' })),
    };

    return {
        launcher,

        /**
         * Pushes a new snapshot, as the main process does on every status change. A settled
         * status also resolves any pending start() or retry() with it.
         */
        emitState(/** @type {Partial<HostingSnapshot>} */ changes) {
            snapshot = makeSnapshot({ ...snapshot, ...changes });
            act(() => {
                for (const callback of listeners.state) {
                    callback(snapshot);
                }
            });
            settlePending();
        },

        emitUrlChanged(/** @type {UrlChange} */ change) {
            act(() => {
                for (const callback of listeners.urlChanged) {
                    callback(change);
                }
            });
        },

        emitPowerStatus(/** @type {PowerStatus} */ status) {
            act(() => {
                for (const callback of listeners.power) {
                    callback(status);
                }
            });
        },

        emitRoomStats(/** @type {RoomStats | null} */ stats) {
            act(() => {
                for (const callback of listeners.roomStats) {
                    callback(stats);
                }
            });
        },

        /** How many subscriptions are still open, to check they are all removed on unmount. */
        listenerCount() {
            return listeners.state.size + listeners.urlChanged.size + listeners.power.size + listeners.roomStats.size;
        },
    };
}
