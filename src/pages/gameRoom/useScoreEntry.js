import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { game } from '@/api/game';
import { useEntryStatus } from '@/hooks/useEntryStatus';
import { browserSessionStorage } from '@/lib/pendingCards';
import { createScoreLifecycle } from '@/lib/scoreLifecycle';

// document.wasDiscarded stays true for the page's whole life, while a lifecycle lasts one visit to a
// room, so the background-reload toast is remembered here to show it once per page load (X21).
let hasShownDiscardToast = false;

function takeDiscardNotice() {
    if (document.wasDiscarded !== true || hasShownDiscardToast) {
        return false;
    }
    hasShownDiscardToast = true;
    return true;
}

/** What the room is told about an open entry (X40); null when none is open. */
function entryStatusState(entry) {
    if (!entry) {
        return null;
    }
    if (entry.source === 'scanner') {
        return 'scanning';
    }
    return 'typing';
}

/**
 * The player's score entry for the active game: renders the state of src/lib/scoreLifecycle.js, which
 * owns the behaviour, and sends it what the player does.
 *
 * @param {object} context
 * @param {object|null} context.room
 * @param {object|null} context.currentPlayer
 * @param {object[]} context.roundScores
 * @param {boolean} context.isHost
 * @param {Function} context.perform  from useActionRunner
 * @param {(options: object) => Promise<'confirm'|'cancel'|'dismiss'>} context.ask  from useConfirmDialog
 */
export function useScoreEntry({ room, currentPlayer, roundScores, isHost, perform, ask }) {
    // The lifecycle outlives any one render, so its ports reach this render's functions through a ref.
    const latest = useRef({ perform, ask });
    latest.current = { perform, ask };

    const [lifecycle] = useState(() => createScoreLifecycle({
        game,
        perform: (...args) => latest.current.perform(...args),
        ask: (options) => latest.current.ask(options),
        notify: toast,
        storage: browserSessionStorage(),
        takeDiscardNotice,
    }));
    const { entry, editorStart, enteredScoreRound } = useSyncExternalStore(lifecycle.subscribe, lifecycle.getState);

    // A layout effect, so a child's effect sending an intent can't act on the room before this one.
    useLayoutEffect(() => {
        lifecycle.sync({ room, currentPlayer, roundScores, isHost });
    }, [lifecycle, room, currentPlayer, roundScores, isHost]);

    const roomId = room?.id ?? null;
    const announceEntry = useEntryStatus({ roomId, round: entry?.roundNumber ?? null, state: entryStatusState(entry) });

    // Sent directly, not left to an effect, because opening the camera can suspend the page and
    // kill the socket (X26). It also gives the status its full time limit from this moment.
    const startScanning = () => announceEntry('scanning');

    const pendingDraft = lifecycle.readDraft(room);

    return {
        showScanner: entry?.source === 'scanner',
        showManualEntry: entry?.source === 'manual',
        pendingCards: pendingDraft?.cards ?? [],
        pendingDuplicateAllowed: pendingDraft?.duplicateAllowed === true,
        pendingAttackPlayerId: pendingDraft?.flip7AttackPlayerId ?? null,
        savePendingDraft: lifecycle.saveDraft,
        savePendingDuplicateAllowed: lifecycle.saveDuplicateAllowed,
        savePendingAttack: lifecycle.saveAttack,
        openScoreEntry: lifecycle.openEntry,
        closeScoreEntry: lifecycle.closeEntry,
        startScanning,
        switchToManualEntry: lifecycle.switchToManualEntry,
        submitScore: lifecycle.submit,
        bust: lifecycle.bust,
        takeBackScore: lifecycle.takeBack,
        addMinusCard: lifecycle.addMinusCard,
        editorStart,
        enteredScoreRound,
        clearEnteredScoreRound: lifecycle.clearEnteredScoreRound,
    };
}
