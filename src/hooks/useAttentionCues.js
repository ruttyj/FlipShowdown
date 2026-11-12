import { useCallback, useEffect, useRef } from 'react';
import {
    IDLE_CUE_STATE,
    applyTitleCue,
    clearTitleCue,
    vibrationFor,
} from '@/lib/attentionCues';

// Returns cue(kind, text). While the page is hidden the tab title gets a "• text — title"
// prefix (restored when the page is visible again) and important kinds vibrate.
// Kinds 'turn', 'gameStart' and 'gameEnd' vibrate; any other kind only changes the title.
export function useAttentionCues() {
    const stateRef = useRef(IDLE_CUE_STATE);

    const restoreTitle = useCallback(() => {
        if (stateRef.current.baseTitle !== null) {
            document.title = stateRef.current.baseTitle;
        }
        stateRef.current = clearTitleCue();
    }, []);

    useEffect(() => {
        const handleVisibility = () => {
            if (document.visibilityState === 'visible') {
                restoreTitle();
            }
        };
        document.addEventListener('visibilitychange', handleVisibility);
        return () => {
            document.removeEventListener('visibilitychange', handleVisibility);
            restoreTitle();
        };
    }, [restoreTitle]);

    return useCallback((kind, text) => {
        const isHidden = document.visibilityState === 'hidden';
        const next = applyTitleCue(stateRef.current, document.title, text, isHidden);
        if (next !== stateRef.current) {
            stateRef.current = next;
            document.title = next.title;
        }

        const pattern = vibrationFor(kind);
        if (pattern && typeof navigator.vibrate === 'function') {
            navigator.vibrate(pattern);
        }
    }, []);
}
