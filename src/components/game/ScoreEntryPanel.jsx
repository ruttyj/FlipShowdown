import React, { useEffect, useId, useRef } from 'react';
import BackButton from '@/components/ui/BackButton';
import { RulesButton } from '@/components/game/RulesSheet';
import { getRules } from '@/lib/gameRules';
import { cn } from '@/lib/utils';
import { keepAtTop } from '@/lib/keepInClearView';

// Gap kept above anything scrolled to the top of the screen (scrollToTop reads it): clear of
// the notch / status bar (safe area) plus breathing room, so the panel's border and header
// are never cut off.
export const SCROLL_MARGIN_CLASS = 'scroll-mt-[calc(env(safe-area-inset-top)+1rem)]';

/**
 * The card both score-entry screens (scanner and manual entry) sit in, so Back, the title and
 * the Confirm bar are in the same place on each. Scrolls itself into view when it opens, and
 * again whenever scrollRequest changes.
 *
 * @param {object} props
 * @param {string} props.title
 * @param {() => void} props.onBack
 * @param {boolean} [props.backDisabled]
 * @param {React.ReactNode} [props.footer]  sticks to the bottom of the screen (the Confirm button)
 * @param {number} [props.scrollRequest]  change it to scroll the panel back into view
 * @param {string} [props.gameMode]  the room's mode, for its reminder line and the rules sheet
 * @param {number} [props.maxScore]  the room's target, for the rules sheet
 * @param {React.ReactNode} [props.children]
 */
export default function ScoreEntryPanel({ title, onBack, backDisabled = false, footer, scrollRequest = 0, gameMode, maxScore, children }) {
    const panelRef = useRef(null);
    const titleId = useId();
    const { entryReminder } = getRules(gameMode);

    useEffect(() => {
        return keepAtTop(panelRef.current);
    }, [scrollRequest]);

    return (
        <section
            ref={panelRef}
            aria-labelledby={titleId}
            className={cn('bg-white rounded-2xl border border-slate-200 shadow-sm', SCROLL_MARGIN_CLASS)}
        >
            {/* Back on the left, the title centred, and Rules in an equal column on the right so
                the title stays centred whatever the Back button's width. */}
            <header className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 py-2 border-b border-slate-100">
                <BackButton
                    onClick={onBack}
                    disabled={backDisabled}
                    className="justify-self-start h-9 -ml-1 text-slate-600 hover:text-slate-900 hover:bg-slate-100"
                />
                <h2 id={titleId} className="text-base font-semibold text-slate-900">
                    {title}
                </h2>
                <div className="justify-self-end">
                    <RulesButton gameMode={gameMode} maxScore={maxScore} variant="onLight" />
                </div>
            </header>

            <div className="p-4 sm:p-6 space-y-4">
                {entryReminder && <p className="text-xs text-center text-slate-500">{entryReminder}</p>}
                {children}
            </div>

            {footer && (
                // Sticks to the bottom of the screen so Confirm stays reachable on a long panel.
                <div data-sticky-footer className="sticky bottom-0 z-10 px-4 sm:px-6 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] rounded-b-2xl border-t border-slate-100 bg-white/85 backdrop-blur space-y-3">
                    {footer}
                </div>
            )}
        </section>
    );
}
