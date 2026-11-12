import { useCallback, useRef, useState } from 'react';
import { runAction } from '@/lib/runAction';

/**
 * Runs game actions through runAction with one busy flag per action name.
 *
 * `perform(name, label, fn, options)` resolves with `fn()`'s result, or undefined when it
 * failed (runAction has shown the toast) or the same action is still running. A second tap
 * while an action is in flight is ignored, even before the busy flag has re-rendered.
 * After a success it refetches the room, unless `options.refetchAfter` is false: the action
 * response is a snapshot, but useRoomData has no way to apply one, and the realtime events
 * alone can be missed on a weak connection.
 *
 * @param {{ refetch: () => void }} options
 * @returns {{ busy: Object<string, boolean>, perform: Function }}
 */
export function useActionRunner({ refetch }) {
    const [busy, setBusy] = useState({});
    const inFlightRef = useRef(new Set());

    const perform = useCallback(async (name, label, fn, { refetchAfter = true } = {}) => {
        if (inFlightRef.current.has(name)) {
            return undefined;
        }
        inFlightRef.current.add(name);

        const setBusyFlag = (isBusy) => {
            setBusy((previous) => ({ ...previous, [name]: isBusy }));
        };

        try {
            const result = await runAction(label, fn, { setBusy: setBusyFlag });
            if (result !== undefined && refetchAfter) {
                refetch();
            }
            return result;
        } finally {
            inFlightRef.current.delete(name);
        }
    }, [refetch]);

    return { busy, perform };
}
