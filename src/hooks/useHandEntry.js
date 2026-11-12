import { useState } from 'react';
import { changeBust, readHandEntry, startHandEntry } from '@/lib/handEntry';

/**
 * One hand entry held for a screen: what `readHandEntry` says about it, the raw rows and switches, and
 * the changes a screen can make. The on-change callbacks are how a draft gets saved.
 *
 * @param {object} options
 * @param {import('@/lib/handEntry').HandEntryStart} [options.start]  read on the first render only
 * @param {string} [options.gameMode]
 * @param {{id: string}[]} [options.attackTargets]
 * @param {boolean} [options.allowsEmptyHand]
 * @param {(cards: {type: string, value: string}[]) => void} [options.onCardsChange]
 * @param {(isOn: boolean) => void} [options.onDuplicateAllowedChange]
 * @param {(playerId: string|null) => void} [options.onAttackChange]
 */
export function useHandEntry({ start, gameMode, attackTargets, allowsEmptyHand, onCardsChange, onDuplicateAllowedChange, onAttackChange }) {
    const [entry, setEntry] = useState(() => startHandEntry(start, gameMode));

    const setCards = (cards) => {
        setEntry((current) => ({ ...current, cards }));
        onCardsChange?.(cards);
    };

    const setOverride = (isOn) => {
        setEntry((current) => ({ ...current, overrideOn: isOn }));
        onDuplicateAllowedChange?.(isOn);
    };

    const setAttack = (playerId) => {
        setEntry((current) => ({ ...current, chosenAttackId: playerId }));
        onAttackChange?.(playerId);
    };

    const setBust = (isOn) => {
        setEntry((current) => changeBust(current, isOn));
    };

    /** Replaces the whole entry with a new hand; with no argument, an empty one. */
    const load = (nextStart) => {
        const next = startHandEntry(nextStart, gameMode);
        setEntry(next);
        onCardsChange?.(next.cards);
        onDuplicateAllowedChange?.(next.overrideOn);
        onAttackChange?.(next.chosenAttackId);
    };

    return {
        cards: entry.cards,
        overrideOn: entry.overrideOn,
        isBustOn: entry.isBustOn,
        ...readHandEntry(entry, { gameMode, attackTargets, allowsEmptyHand }),
        setCards,
        setOverride,
        setAttack,
        setBust,
        load,
    };
}
