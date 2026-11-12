import React, { useEffect, useId, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { applyMisreadFix, canOverrideDuplicate, handReminder, misreadFixes } from '@/lib/handFixes';

/**
 * "Came from a Steal or Swap": the player vouching that a duplicate wasn't flipped, which undoes the
 * bust (X45). Stays on screen while on, so it can be turned off again.
 *
 * @param {object} props
 * @param {boolean} props.checked
 * @param {(checked: boolean) => void} props.onCheckedChange
 */
export function DuplicateOverrideSwitch({ checked, onCheckedChange }) {
    const switchId = useId();

    return (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
            <label htmlFor={switchId} className="text-sm font-medium text-slate-700">
                Came from a Steal or Swap
            </label>
            <Switch id={switchId} checked={checked} onCheckedChange={onCheckedChange} />
        </div>
    );
}

/**
 * Sits under the score summary: a one-tap fix for a bust that may be a misread special card, and a
 * quiet reminder about Unlucky 7. The fixes are plain buttons, so they raise no keyboard.
 *
 * Tapping a fix usually removes that button, which would drop focus to the page. So focus moves to
 * an empty element that is always here, with the words in a live region that is always here too, as
 * screen readers only announce a change in a region they already know about.
 *
 * @param {object} props
 * @param {{type: string, value: string}[]} props.cards  the rows being edited
 * @param {import('@/lib/handScoring').HandScore} props.score  the hand's score
 * @param {string} [props.gameMode]
 * @param {(cards: {type: string, value: string}[]) => void} props.onCardsChange
 * @param {boolean} [props.duplicateAllowed]  the override's switch
 * @param {(checked: boolean) => void} [props.onDuplicateAllowedChange]  shows the override here. The
 *        score editor leaves it out, as it has the switch above the cards.
 */
export default function HandNotes({ cards, score, gameMode, onCardsChange, duplicateAllowed = false, onDuplicateAllowedChange }) {
    // { message, handKey } of the last fix: it stops showing as soon as the hand is different.
    const [lastFix, setLastFix] = useState(null);
    const focusTargetRef = useRef(null);

    const fixes = misreadFixes(cards, score, gameMode);
    const reminder = handReminder(cards, gameMode);
    const offersOverride = Boolean(onDuplicateAllowedChange) && canOverrideDuplicate(cards, gameMode);
    const handKey = JSON.stringify(cards);
    const announcement = lastFix?.handKey === handKey ? lastFix.message : '';

    useEffect(() => {
        if (lastFix) {
            focusTargetRef.current?.focus();
        }
    }, [lastFix]);

    const applyFix = (fix) => {
        const fixedCards = applyMisreadFix(cards, fix.value);
        setLastFix({ message: fix.announcement, handKey: JSON.stringify(fixedCards) });
        onCardsChange(fixedCards);
    };

    return (
        <>
            <span ref={focusTargetRef} tabIndex={-1} className="sr-only" />
            <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
            {(fixes.length > 0 || reminder || offersOverride) && (
                <div className="space-y-2">
                    {offersOverride && (
                        <DuplicateOverrideSwitch checked={duplicateAllowed} onCheckedChange={onDuplicateAllowedChange} />
                    )}
                    {fixes.map((fix) => (
                        <button
                            key={fix.value}
                            type="button"
                            onClick={() => applyFix(fix)}
                            className="w-full flex items-center justify-center gap-2 rounded-xl border-2 border-rose-300 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-800 hover:bg-rose-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
                        >
                            <Sparkles className="w-4 h-4 shrink-0" aria-hidden="true" />
                            {fix.label}
                        </button>
                    ))}
                    {reminder && <p className="text-xs text-center text-slate-500">{reminder}</p>}
                </div>
            )}
        </>
    );
}
