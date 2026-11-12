import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from './errorMessage.js';
import { isSessionRunning } from './hostingStatus.js';

/** @typedef {import('../shared/launcherBridge').LauncherBridge} LauncherBridge */
/** @typedef {import('../shared/launcherBridge').HostingSnapshot} HostingSnapshot */
/** @typedef {import('../shared/launcherBridge').UrlChange} UrlChange */

/**
 * Runs Start, Retry or Stop and shows the snapshot it resolves with. The bridge says start and
 * retry never reject, but a broken IPC channel still can, so every action turns a rejection into
 * the message the Home screen shows instead of an unhandled rejection.
 * @param {{ action: () => Promise<HostingSnapshot>, failure: string,
 *   setSnapshot: (snapshot: HostingSnapshot) => void,
 *   setActionError: (message: string | null) => void }} context
 */
async function runSessionAction({ action, failure, setSnapshot, setActionError }) {
    setActionError(null);
    try {
        setSnapshot(await action());
    } catch (error) {
        setActionError(`${failure}: ${errorMessage(error)}`);
    }
}

/**
 * The hosting session as the Home screen sees it: the latest snapshot (null until the first
 * one arrives), the last link change while hosting, the Start/Stop/Retry actions and why the
 * last of them failed (null when it didn't).
 * @param {LauncherBridge} launcher
 */
export function useHostingSession(launcher) {
    const [snapshot, setSnapshot] = useState(/** @type {HostingSnapshot | null} */ (null));
    const [urlChange, setUrlChange] = useState(/** @type {UrlChange | null} */ (null));
    const [actionError, setActionError] = useState(/** @type {string | null} */ (null));

    useEffect(() => {
        let isSubscribed = true;

        const unsubscribeState = launcher.onState((next) => {
            setSnapshot(next);
            // A session that has stopped no longer has a link to rescan.
            if (!isSessionRunning(next.status)) {
                setUrlChange(null);
            }
        });
        const unsubscribeUrl = launcher.onUrlChanged((change) => {
            // The first link of a session (previousUrl null) is not a change.
            if (change.previousUrl !== null) {
                setUrlChange(change);
            }
        });

        // A state pushed while this was in flight is newer, so the reply only fills a gap.
        launcher.getState().then((initial) => {
            if (isSubscribed) {
                setSnapshot((current) => current ?? initial);
            }
        });

        return () => {
            isSubscribed = false;
            unsubscribeState();
            unsubscribeUrl();
        };
    }, [launcher]);

    const start = useCallback(() => runSessionAction({
        action: () => launcher.start(),
        failure: "Couldn't start hosting",
        setSnapshot,
        setActionError,
    }), [launcher]);

    const retry = useCallback(() => runSessionAction({
        action: () => launcher.retry(),
        failure: "Couldn't retry",
        setSnapshot,
        setActionError,
    }), [launcher]);

    const stop = useCallback(() => runSessionAction({
        action: () => launcher.stop(),
        failure: "Couldn't stop hosting",
        setSnapshot,
        setActionError,
    }), [launcher]);

    const dismissUrlChange = useCallback(() => setUrlChange(null), []);

    return { snapshot, urlChange, actionError, start, stop, retry, dismissUrlChange };
}
