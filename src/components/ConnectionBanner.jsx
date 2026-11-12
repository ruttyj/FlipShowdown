import React, { useEffect, useState } from 'react';
import { realtime } from '@/api/backend';
import {
    advanceConnectionClock,
    bannerState,
    createConnectionClock,
    downForMs,
    RECONNECT_DELAY_MS,
} from '@/lib/connectionBanner';

const BAR_CLASSES = 'fixed top-0 inset-x-0 z-50 flex justify-center px-4 py-2 text-sm font-medium text-white shadow-lg';

/** Tracks the realtime status as a connection clock (see src/lib/connectionBanner.js). */
function useConnectionClock() {
    const [clock, setClock] = useState(() => createConnectionClock(realtime.getStatus()));
    const [, forceTick] = useState(0);

    useEffect(() => {
        function handleStatus(nextStatus) {
            setClock((current) => advanceConnectionClock(current, nextStatus, Date.now()));
        }

        const off = realtime.onStatus(handleStatus);
        // The status may have changed between the first render and this subscription.
        handleStatus(realtime.getStatus());
        return off;
    }, []);

    // Re-render once the delay since going down has passed; nothing else changes meanwhile.
    useEffect(() => {
        if (clock.downSince === null || clock.status === 'signed-out') {
            return undefined;
        }
        const remainingMs = clock.downSince + RECONNECT_DELAY_MS - Date.now();
        if (remainingMs <= 0) {
            return undefined;
        }
        const timer = setTimeout(() => forceTick((tick) => tick + 1), remainingMs);
        return () => clearTimeout(timer);
    }, [clock.downSince, clock.status]);

    return clock;
}

export default function ConnectionBanner() {
    const clock = useConnectionClock();
    const state = bannerState(clock.status, downForMs(clock, Date.now()), clock.hasBeenLive);

    if (state === 'signed-out') {
        return (
            <div role="status" aria-live="polite" className={`${BAR_CLASSES} bg-rose-700`}>
                <button type="button" className="underline" onClick={() => window.location.reload()}>
                    Signed out — tap to continue
                </button>
            </div>
        );
    }

    if (state === 'reconnecting') {
        return (
            <div role="status" aria-live="polite" className={`${BAR_CLASSES} bg-amber-600`}>
                Reconnecting…
            </div>
        );
    }

    // Keep the live region mounted so screen readers announce the next change.
    return <div role="status" aria-live="polite" className="sr-only" />;
}
