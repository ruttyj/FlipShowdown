import { toast } from 'sonner';

const SIGNED_OUT_STATUS = 401;

function showErrorToast(message) {
    toast.error(message);
}

/**
 * Runs a UI action with a busy flag and an error toast.
 *
 * Resolves with `fn()`'s result, or `undefined` when it fails. A failure shows
 * "<label> failed: <message>"; a 401 shows nothing because the signed-out banner covers it.
 *
 * @param {string} label  What the user tried, e.g. 'Start game'
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ setBusy?: (isBusy: boolean) => void, showToast?: (message: string) => void }} [options]
 *        `showToast` is injectable for tests
 * @returns {Promise<T|undefined>}
 */
export async function runAction(label, fn, { setBusy, showToast = showErrorToast } = {}) {
    if (setBusy) {
        setBusy(true);
    }

    try {
        return await fn();
    } catch (error) {
        if (error?.status !== SIGNED_OUT_STATUS) {
            showToast(`${label} failed: ${error?.message ?? 'unknown error'}`);
        }
        return undefined;
    } finally {
        if (setBusy) {
            setBusy(false);
        }
    }
}
