// The "Copied" / "Couldn't copy" feedback the room code buttons share (X66).
import { useEffect, useState } from 'react';

export const COPIED_MS = 2000;

/** @typedef {'idle' | 'copied' | 'failed'} CopyState */

/**
 * Copies text to the clipboard and remembers how it went for COPIED_MS, then goes back to idle.
 * @returns {{ state: CopyState, copy: (text: string) => Promise<void> }}
 */
export function useCopyState() {
    const [state, setState] = useState(/** @type {CopyState} */ ('idle'));

    useEffect(() => {
        if (state === 'idle') {
            return undefined;
        }
        const timer = setTimeout(() => setState('idle'), COPIED_MS);
        return () => clearTimeout(timer);
    }, [state]);

    async function copy(/** @type {string} */ text) {
        try {
            await navigator.clipboard.writeText(text);
            setState('copied');
        } catch {
            setState('failed');
        }
    }

    return { state, copy };
}
