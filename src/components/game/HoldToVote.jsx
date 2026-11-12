import React, { useEffect } from 'react';
import { motion } from 'framer-motion';
import { useVote } from '@/hooks/useVote';
import { holderLabel } from '@/lib/holderLabel';
import { VOTE_HOLD_MS, optionState } from '@/lib/voteState';

// Green only ever means I'm voting; blue means other players are and I'm not.
const STATUS_CLASSES = {
    idle: 'bg-slate-100 border-slate-200 text-slate-800',
    mine: 'bg-emerald-100 border-emerald-400 text-emerald-900',
    others: 'bg-blue-100 border-blue-400 text-blue-900',
};
const PENDING_MINE_CLASSES = 'bg-emerald-200 border-emerald-500 text-emerald-900';
const PENDING_OTHERS_CLASSES = 'bg-blue-200 border-blue-500 text-blue-900';

const HOLD_KEYS = ['Enter', ' '];

function buttonClasses(status, iHold) {
    if (status !== 'pending') {
        return STATUS_CLASSES[status];
    }
    return iHold ? PENDING_MINE_CLASSES : PENDING_OTHERS_CLASSES;
}

/** Fills from where the server's countdown is now to full, linearly, for the time left. */
function PendingProgress({ remainingMs, receivedAt, iHold }) {
    const startFraction = 1 - remainingMs / VOTE_HOLD_MS;
    const fillClass = iHold ? 'bg-emerald-500/40' : 'bg-blue-500/40';

    return (
        <motion.div
            key={receivedAt}
            aria-hidden="true"
            className={`absolute inset-y-0 left-0 ${fillClass}`}
            initial={{ width: `${startFraction * 100}%` }}
            animate={{ width: '100%' }}
            transition={{ duration: remainingMs / 1000, ease: 'linear' }}
        />
    );
}

/**
 * A press-and-hold vote button, reusable for any topic. Everyone holds the same `option` at
 * the same time; the server decides when the vote passes.
 * `holderNames` maps player id to display name for the "Holding" line.
 */
export default function HoldToVote({ roomId, topic, option, label, myPlayerId, holderNames }) {
    const { voteState, hold, release } = useVote(roomId, topic);
    const { status, holderIds, iHold, remainingMs } = optionState(voteState, option, myPlayerId, Date.now());

    // Switching app or window mid-press never sends a pointerup to this page.
    useEffect(() => {
        window.addEventListener('blur', release);
        return () => {
            window.removeEventListener('blur', release);
        };
    }, [release]);

    function handlePointerDown(event) {
        // Only the main touch or the left mouse button votes; a right click or a second
        // finger must not start a hold.
        const isMainButton = event.isPrimary && event.button === 0;
        if (!isMainButton) {
            return;
        }

        // Keeps pointerup coming to this button even when the finger drifts off it.
        event.currentTarget.setPointerCapture(event.pointerId);
        hold(option);
    }

    function handleKeyDown(event) {
        if (!HOLD_KEYS.includes(event.key)) {
            return;
        }

        // Stops Space scrolling the page, and key repeat re-sending the hold.
        event.preventDefault();
        if (!event.repeat) {
            hold(option);
        }
    }

    function handleKeyUp(event) {
        if (HOLD_KEYS.includes(event.key)) {
            release();
        }
    }

    let holdingText = 'Press and hold';
    if (holderIds.length > 0) {
        holdingText = `Holding: ${holderLabel(holderIds, holderNames)}`;
    }

    return (
        <button
            type="button"
            aria-label={`Hold to vote for ${label}`}
            data-status={status}
            onPointerDown={handlePointerDown}
            onPointerUp={release}
            onPointerCancel={release}
            onLostPointerCapture={release}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            onBlur={release}
            onContextMenu={(event) => event.preventDefault()}
            style={{ touchAction: 'none', WebkitTouchCallout: 'none' }}
            className={`relative w-full overflow-hidden rounded-xl border-2 px-4 py-3 text-left select-none transition-colors ${buttonClasses(status, iHold)}`}
        >
            {status === 'pending' && (
                <PendingProgress remainingMs={remainingMs} receivedAt={voteState.receivedAt} iHold={iHold} />
            )}
            <span className="relative block font-semibold">{label}</span>
            <span className="relative block text-xs min-h-4">{holdingText}</span>
        </button>
    );
}
