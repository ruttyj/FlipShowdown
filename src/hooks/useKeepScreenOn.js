import { useEffect } from 'react';

// --- Lock handling ---------------------------------------------------------------

/**
 * @typedef {object} ScreenLock
 * @property {WakeLockSentinel|null} sentinel  the lock held right now
 * @property {boolean} isWanted  false once the hook has unmounted
 */

/** @param {ScreenLock} lock */
async function acquireLock(lock) {
    if (lock.sentinel) {
        return;
    }

    let sentinel;
    try {
        sentinel = await navigator.wakeLock.request('screen');
    } catch {
        // Denied (low battery, not visible). Retried on the next visibility change.
        return;
    }

    // While the request was pending the hook may have unmounted, or a second request
    // (visibility change) may have won the race; don't keep an extra lock.
    const isUnwanted = !lock.isWanted || lock.sentinel !== null;
    if (isUnwanted) {
        releaseSentinel(sentinel);
        return;
    }

    sentinel.addEventListener('release', () => {
        if (lock.sentinel === sentinel) {
            lock.sentinel = null;
        }
    });
    lock.sentinel = sentinel;
}

function releaseSentinel(sentinel) {
    sentinel.release().catch(() => {
        // Already released by the browser: nothing left to do.
    });
}

// --- Hook ------------------------------------------------------------------------

/**
 * Keeps the screen on while mounted, so phones don't lock mid-game (X28). Browsers only expose
 * navigator.wakeLock in a secure context (HTTPS or localhost), so on plain HTTP this does nothing,
 * and a denied lock is equally silent: play carries on either way.
 */
export function useKeepScreenOn() {
    useEffect(() => {
        if (!('wakeLock' in navigator)) {
            return undefined;
        }

        const lock = { sentinel: null, isWanted: true };
        acquireLock(lock);

        // The browser drops the lock whenever the page is hidden.
        const handleVisibility = () => {
            if (document.visibilityState === 'visible') {
                acquireLock(lock);
            }
        };
        document.addEventListener('visibilitychange', handleVisibility);

        return () => {
            lock.isWanted = false;
            document.removeEventListener('visibilitychange', handleVisibility);
            if (lock.sentinel) {
                releaseSentinel(lock.sentinel);
                lock.sentinel = null;
            }
        };
    }, []);
}
