// Small subscriptions the launcher page keeps: the power source, the room stats, the update check
// and the app version. The hosting session has its own hook (useHostingSession).
import { useEffect, useState } from 'react';

/** @typedef {import('../shared/launcherBridge').LauncherBridge} LauncherBridge */
/** @typedef {import('../shared/launcherBridge').RoomStats} RoomStats */
/** @typedef {import('../shared/launcherBridge').UpdateResult} UpdateResult */

// --- Room stats ----------------------------------------------------------------------------

/**
 * The server's latest room stats (X66), or null while not hosting. A failed first read only
 * waits for the next push, so it's ignored.
 * @param {LauncherBridge} launcher
 * @returns {RoomStats | null}
 */
export function useRoomStats(launcher) {
    const [stats, setStats] = useState(/** @type {RoomStats | null} */ (null));

    useEffect(() => {
        let isSubscribed = true;
        let hasPush = false;
        const unsubscribe = launcher.onRoomStats((next) => {
            hasPush = true;
            setStats(next);
        });

        // A push that lands before the read answers is newer, so the read doesn't overwrite it.
        launcher.getRoomStats()
            .then((initial) => {
                if (isSubscribed && !hasPush) {
                    setStats(initial);
                }
            })
            .catch(() => {});

        return () => {
            isSubscribed = false;
            unsubscribe();
        };
    }, [launcher]);

    return stats;
}

// --- Power ---------------------------------------------------------------------------------

/**
 * True while the computer runs on battery; false until the first reply, or if it fails.
 * @param {LauncherBridge} launcher
 */
export function useOnBattery(launcher) {
    const [onBattery, setOnBattery] = useState(false);

    useEffect(() => {
        let isSubscribed = true;
        const unsubscribe = launcher.onPowerStatus((status) => setOnBattery(status.onBattery));

        // A failed read only loses the battery hint until the next power event, so it's ignored.
        launcher.getPowerStatus()
            .then((status) => {
                if (isSubscribed) {
                    setOnBattery(status.onBattery);
                }
            })
            .catch(() => {});

        return () => {
            isSubscribed = false;
            unsubscribe();
        };
    }, [launcher]);

    return onBattery;
}

// --- Update check --------------------------------------------------------------------------

/**
 * Checks for a newer release once. Resolves to the update when there is one, otherwise null,
 * including when the check fails: the launcher works offline and only notifies.
 * @param {LauncherBridge} launcher
 * @returns {UpdateResult | null}
 */
export function useAvailableUpdate(launcher) {
    const [update, setUpdate] = useState(/** @type {UpdateResult | null} */ (null));

    useEffect(() => {
        let isSubscribed = true;

        launcher.checkForUpdate()
            .then((result) => {
                if (isSubscribed && result.updateAvailable) {
                    setUpdate(result);
                }
            })
            .catch(() => {});

        return () => {
            isSubscribed = false;
        };
    }, [launcher]);

    return update;
}

// --- App version ---------------------------------------------------------------------------

/**
 * The launcher's version, or null until it arrives (or if it can't be read).
 * @param {LauncherBridge} launcher
 */
export function useAppVersion(launcher) {
    const [version, setVersion] = useState(/** @type {string | null} */ (null));

    useEffect(() => {
        let isSubscribed = true;

        // A failed read only hides the version line, so it's ignored.
        launcher.getAppInfo()
            .then((info) => {
                if (isSubscribed) {
                    setVersion(info.version);
                }
            })
            .catch(() => {});

        return () => {
            isSubscribed = false;
        };
    }, [launcher]);

    return version;
}
