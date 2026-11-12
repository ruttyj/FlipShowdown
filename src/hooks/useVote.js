import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { roomChannel } from '@/api/backend';

/**
 * Hold-to-vote for one room and topic.
 *
 * Returns `{ voteState, hold(option), release() }`. `voteState` is the latest state for this room
 * and topic (null until the first one arrives; see src/lib/voteState.js). `onPassed(option)` and
 * `onError(code)` are called when this room and topic's vote passes or is refused.
 *
 * My hold is released on unmount, when the tab is hidden and on pagehide, so a phone that
 * is locked mid-press can't leave a stuck hold behind.
 *
 * @param {string} roomId
 * @param {string} topic
 * @param {{ onPassed?: (option: string) => void, onError?: (code: string) => void }} [callbacks]
 */
export function useVote(roomId, topic, { onPassed, onError } = {}) {
    const ballotRef = useRef(null);
    const callbacksRef = useRef({ onPassed, onError });

    useEffect(() => {
        callbacksRef.current = { onPassed, onError };
    });

    const voteState = useSyncExternalStore(roomChannel.subscribeVotes, () => roomChannel.getVote(roomId, topic));

    useEffect(() => {
        if (!roomId) {
            return undefined;
        }

        const ballot = roomChannel.openBallot(roomId, topic, {
            onPassed: (option) => callbacksRef.current.onPassed?.(option),
            onError: (code) => callbacksRef.current.onError?.(code),
        });
        ballotRef.current = ballot;

        return () => {
            ballotRef.current = null;
            ballot.close();
        };
    }, [roomId, topic]);

    const release = useCallback(() => {
        ballotRef.current?.release();
    }, []);

    const hold = useCallback((option) => {
        ballotRef.current?.hold(option);
    }, []);

    useEffect(() => {
        function releaseWhenHidden() {
            if (document.visibilityState === 'hidden') {
                release();
            }
        }

        document.addEventListener('visibilitychange', releaseWhenHidden);
        window.addEventListener('pagehide', release);
        return () => {
            document.removeEventListener('visibilitychange', releaseWhenHidden);
            window.removeEventListener('pagehide', release);
        };
    }, [release]);

    return { voteState, hold, release };
}
