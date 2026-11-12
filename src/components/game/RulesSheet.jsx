import React, { forwardRef, useRef, useState } from 'react';
import { BookOpen } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { GAME_MODES, getRules } from '@/lib/gameRules';
import { UNOFFICIAL_DISCLAIMER } from '@/lib/disclaimer';
import { DEFAULT_MAX_SCORE } from '@/lib/maxScore';

const TRIGGER_STYLES = {
    onDark: 'bg-white/10 text-white hover:bg-white/20 focus-visible:ring-white',
    onLight: 'text-slate-600 hover:bg-slate-100 focus-visible:ring-ui-accent-vivid',
};

/** The visible Rules button; whoever renders it owns the sheet. */
export const RulesTrigger = forwardRef(/** @type {React.ForwardRefRenderFunction<HTMLButtonElement, {onClick: () => void, variant?: 'onDark'|'onLight'}>} */ (function RulesTrigger({ onClick, variant = 'onDark' }, ref) {
    return (
        <button
            ref={ref}
            type="button"
            onClick={onClick}
            className={`inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-semibold focus:outline-none focus-visible:ring-2 ${TRIGGER_STYLES[variant]}`}
        >
            <BookOpen className="w-4 h-4" aria-hidden="true" />
            Rules
        </button>
    );
}));

/** The room's target. One changed from the default shows the default struck through beside it. */
function TargetScore({ maxScore }) {
    if (maxScore === DEFAULT_MAX_SCORE) {
        return maxScore;
    }

    return (
        <>
            <span className="sr-only">Changed from {DEFAULT_MAX_SCORE} to </span>
            <s aria-hidden="true" className="font-normal text-slate-400">{DEFAULT_MAX_SCORE}</s>
            {' '}
            <strong className="font-bold">{maxScore}</strong>
        </>
    );
}

/** One rule as two modes play it, stacked so it fits a 360 px screen. */
function RuleComparison({ comparison, baseLabel, modeLabel }) {
    return (
        <div className="rounded-lg bg-slate-100 p-3">
            <h4 className="font-semibold text-slate-900">{comparison.topic}</h4>
            <dl className="mt-1 space-y-1">
                <div>
                    <dt className="text-xs font-semibold uppercase text-slate-500">{baseLabel}</dt>
                    <dd>{comparison.base}</dd>
                </div>
                <div>
                    <dt className="text-xs font-semibold uppercase text-ui-accent-strong">{modeLabel}</dt>
                    <dd>{comparison.mode}</dd>
                </div>
            </dl>
        </div>
    );
}

function ModeRules({ rules, maxScore }) {
    const { goal, sections, sourceUrl, faqUrl } = rules.rulesContent;

    return (
        <div className="space-y-4 text-sm text-slate-700">
            <p className="text-xs text-slate-500">{rules.edition}</p>
            <p className="font-medium text-slate-900">
                {goal.before}
                <TargetScore maxScore={maxScore} />
                {goal.after}
            </p>
            {sections.map((section) => (
                <section key={section.title}>
                    <h3 className="mb-1 font-semibold text-slate-900">{section.title}</h3>
                    {section.note && <p className="mb-2">{section.note}</p>}
                    {section.comparisons && (
                        <div className="mb-2 space-y-2">
                            {section.comparisons.map((comparison) => (
                                <RuleComparison
                                    key={comparison.topic}
                                    comparison={comparison}
                                    baseLabel={section.baseLabel}
                                    modeLabel={rules.label}
                                />
                            ))}
                        </div>
                    )}
                    {section.items && (
                        <ul className="list-disc space-y-1 pl-5">
                            {section.items.map((item) => (
                                <li key={item}>{item}</li>
                            ))}
                        </ul>
                    )}
                </section>
            ))}
            <div className="flex flex-wrap gap-x-4 gap-y-1">
                {sourceUrl && (
                    <a
                        href={sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-block font-semibold text-ui-accent-strong underline underline-offset-2"
                    >
                        Official rulebook (PDF)
                    </a>
                )}
                {faqUrl && (
                    <a
                        href={faqUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-block font-semibold text-ui-accent-strong underline underline-offset-2"
                    >
                        Publisher's FAQ
                    </a>
                )}
            </div>
            <p className="text-xs text-slate-500">{UNOFFICIAL_DISCLAIMER}</p>
        </div>
    );
}

/**
 * One tab per game mode. It only explains: changing mode happens in the picker. The tabs scroll
 * sideways rather than wrap at 360 px, so a further mode still fits.
 *
 * @param {object} props
 * @param {boolean} props.open
 * @param {(open: boolean) => void} props.onOpenChange
 * @param {string} [props.initialMode]  the tab to open on
 * @param {string} [props.roomMode]  the tab to mark "This game"; none on Home, where no room exists
 * @param {number} [props.maxScore]  the room's target, shown in the goal
 * @param {() => HTMLElement|null} props.getReturnFocusTarget  where focus goes on closing. The sheet
 *        has no Radix trigger, so Radix would otherwise leave focus on the page.
 */
export function RulesDialog({ open, onOpenChange, initialMode, roomMode, maxScore = DEFAULT_MAX_SCORE, getReturnFocusTarget }) {
    const markedMode = roomMode ? getRules(roomMode).id : null;

    const handleCloseAutoFocus = (event) => {
        event.preventDefault();
        getReturnFocusTarget()?.focus();
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                onCloseAutoFocus={handleCloseAutoFocus}
                className="flex w-[calc(100vw-1.5rem)] max-h-[85dvh] flex-col overflow-hidden rounded-2xl p-0"
            >
                <DialogHeader className="px-6 pt-6">
                    <DialogTitle>Rules</DialogTitle>
                    <DialogDescription>How each game mode plays and scores.</DialogDescription>
                </DialogHeader>
                {/* Only a tab's rules scroll, so Close and the tabs stay in reach on a long one.
                    The dialog's content unmounts on close, so this opens on initialMode every time. */}
                <Tabs defaultValue={getRules(initialMode).id} className="flex min-h-0 min-w-0 flex-1 flex-col">
                    <div className="px-6">
                        <TabsList className="flex w-full justify-start overflow-x-auto">
                            {GAME_MODES.map((rules) => (
                                <TabsTrigger key={rules.id} value={rules.id} className="shrink-0 gap-1.5">
                                    {rules.label}
                                    {rules.id === markedMode && (
                                        <span className="rounded-full bg-ui-accent-tint px-1.5 py-0.5 text-[10px] font-semibold text-ui-accent-deep">
                                            This game
                                        </span>
                                    )}
                                </TabsTrigger>
                            ))}
                        </TabsList>
                    </div>
                    {GAME_MODES.map((rules) => (
                        <TabsContent key={rules.id} value={rules.id} className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">

                            <ModeRules rules={rules} maxScore={maxScore} />
                        </TabsContent>
                    ))}
                </Tabs>
            </DialogContent>
        </Dialog>
    );
}

/**
 * A Rules button with its own sheet, opened on the room's mode.
 *
 * @param {object} props
 * @param {string} [props.gameMode]
 * @param {number} [props.maxScore]
 * @param {'onDark'|'onLight'} [props.variant]
 */
export function RulesButton({ gameMode, maxScore, variant }) {
    const [isOpen, setIsOpen] = useState(false);
    const triggerRef = useRef(null);

    return (
        <>
            <RulesTrigger ref={triggerRef} onClick={() => setIsOpen(true)} variant={variant} />
            <RulesDialog
                open={isOpen}
                onOpenChange={setIsOpen}
                initialMode={gameMode}
                roomMode={getRules(gameMode).id}
                maxScore={maxScore}
                getReturnFocusTarget={() => triggerRef.current}
            />
        </>
    );
}
