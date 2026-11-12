import React, { useId, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Check, X } from 'lucide-react';
import { GAME_MODES, getRules } from '@/lib/gameRules';
import GameLogo from '@/pages/gameRoom/GameLogo';

const BACKDROP_VARIANTS = {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { duration: 0.3, ease: 'easeOut' } },
    exit: { opacity: 0, transition: { duration: 0.22, ease: 'easeIn' } },
};

const PANEL_VARIANTS = {
    hidden: {},
    visible: { transition: { delayChildren: 0.06, staggerChildren: 0.07 } },
    exit: { opacity: 0, scale: 0.97, y: 12, transition: { duration: 0.18, ease: 'easeIn' } },
};

const CARD_VARIANTS = {
    hidden: { opacity: 0, y: 36, scale: 0.94 },
    visible: { opacity: 1, y: 0, scale: 1, transition: { type: 'spring', stiffness: 320, damping: 28 } },
};

const CARD_HOVER = { y: -4, transition: { duration: 0.15 } };
const CARD_TAP = { scale: 0.98 };

// Only the cards scroll, so Close stays in reach. A scroller clips at its padding, which has to hold a
// lifted card's thickest ring: CARD_HOVER's 4 px plus the 4 px focus ring. The margin keeps the cards
// lined up with the title.
const MODE_GRID = 'grid min-h-0 gap-3 overflow-y-auto -mx-1 p-2 md:grid-cols-3';

// A lifted card leaves its old bottom edge behind, and a pointer there would drop it, lift it, and so on.
// This strip fills the gap under the card, so the pointer is still on it.
const LIFT_GAP_COVER = "relative hover:after:absolute hover:after:inset-x-0 hover:after:top-full hover:after:h-1 hover:after:content-['']";

const NEXT_KEYS =['ArrowDown', 'ArrowRight'];
const PREVIOUS_KEYS = ['ArrowUp', 'ArrowLeft'];

/** Reduced motion gets no movement at all: everything appears and leaves at once. */
function presenceProps(prefersReducedMotion) {
    if (prefersReducedMotion) {
        return { initial: false, animate: 'visible' };
    }
    return { initial: 'hidden', animate: 'visible', exit: 'exit' };
}

/**
 * Arrow keys walk the modes, wrapping, the way a radio group does. Focus alone never selects:
 * selecting applies the mode, and walking past one shouldn't change the room. The group also holds
 * the "Full rules" buttons, and an arrow key pressed on one of those does nothing.
 */
function moveRadioFocus(event) {
    const isNext = NEXT_KEYS.includes(event.key);
    const isPrevious = PREVIOUS_KEYS.includes(event.key);
    if (!isNext && !isPrevious) {
        return;
    }

    const radios = [...event.currentTarget.querySelectorAll('[role="radio"]')];
    const currentIndex = radios.indexOf(event.target);
    if (currentIndex === -1) {
        return;
    }

    event.preventDefault();
    const step = isNext ? 1 : -1;
    radios[(currentIndex + step + radios.length) % radios.length].focus();
}

/**
 * Radix would focus the first thing it can, which is the Close button. Focus starts on the current
 * mode, where Enter straight after opening can't apply another one to the room.
 */
function focusCurrentMode(event, contentRef) {
    const currentRadio = contentRef.current?.querySelector('[role="radio"][aria-checked="true"]');
    if (currentRadio) {
        event.preventDefault();
        currentRadio.focus();
    }
}

/**
 * A mode's logo, tagline, the official game it is for (X71) and highlights, which stay visible as phones have no hover. Spans only, so it
 * can sit inside a button.
 *
 * @param {object} props
 * @param {object} props.rules
 * @param {boolean} props.isCurrent
 * @param {string} [props.taglineId]
 * @param {string} [props.editionId]
 * @param {string} [props.highlightsId]
 */
function ModeSummary({ rules, isCurrent, taglineId, editionId, highlightsId }) {
    return (
        <>
            <span className="flex items-start justify-between gap-2">
                <GameLogo mode={rules.id} size="small" />
                {isCurrent && <Check data-testid="current-mode-check" className="w-5 h-5 shrink-0" aria-hidden="true" />}
            </span>
            <span id={taglineId} className="block mt-3 text-sm font-semibold">{rules.tagline}</span>
            <span id={editionId} className="block mt-0.5 text-xs text-white/70">{rules.edition}</span>
            <span id={highlightsId} className="block mt-1 space-y-0.5 text-xs text-white/80">
                {rules.highlights.map((highlight) => (
                    <span key={highlight} className="block">{highlight}</span>
                ))}
            </span>
        </>
    );
}

function FullRulesButton({ rules, onShowRules }) {
    return (
        <button
            type="button"
            aria-label={`Full rules for ${rules.label}`}
            onClick={(event) => onShowRules(rules.id, event.currentTarget)}
            className="mt-3 self-start text-xs font-semibold text-white underline underline-offset-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
            Full rules
        </button>
    );
}

/**
 * One mode for someone who can't change it: the same card, with nothing to select. It has no hover or
 * press, as those would promise a tap does something.
 */
function ReadOnlyModeCard({ rules, isCurrent, onShowRules }) {
    const ring = isCurrent ? 'ring-2 ring-white' : 'ring-1 ring-white/20';

    return (
        <motion.div
            role="listitem"
            variants={CARD_VARIANTS}
            data-game-mode={rules.id}
            className={`game-screen-bg flex flex-col rounded-2xl p-4 shadow-2xl shadow-black/50 ${ring}`}
        >
            <div className="flex-1 text-white">
                <ModeSummary rules={rules} isCurrent={isCurrent} />
                {isCurrent && <span className="sr-only">Current mode</span>}
            </div>
            <FullRulesButton rules={rules} onShowRules={onShowRules} />
        </motion.div>
    );
}

/**
 * One mode: a radio button with the mode's summary, and a separate "Full rules" button beside it that
 * doesn't change the selection. The card's own data-game-mode applies that mode's theme without
 * changing the page. The radio's name is the mode alone, so the tagline and highlights reach screen
 * readers as its description, with the official game it is for.
 *
 * Only one radio is in the tab order at a time (`isTabStop`): the arrow keys move between them.
 */
function ModeCard({ rules, isCurrent, isTabStop, prefersReducedMotion, onFocusRadio, onSelect, onShowRules }) {
    const taglineId = useId();
    const editionId = useId();
    const highlightsId = useId();
    // The picker opens with focus on the current radio, so a ring of its own would make two. There,
    // the card's ring shows focus by thickening.
    const currentRing = isCurrent ? 'ring-2 ring-white has-[[role=radio]:focus-visible]:ring-4' : 'ring-1 ring-white/20';
    const radioFocusRing = isCurrent ? '' : 'focus-visible:ring-2 focus-visible:ring-white';

    return (
        <motion.div
            variants={CARD_VARIANTS}
            whileHover={prefersReducedMotion ? undefined : CARD_HOVER}
            whileTap={prefersReducedMotion ? undefined : CARD_TAP}
            data-game-mode={rules.id}
            className={`game-screen-bg flex flex-col rounded-2xl p-4 shadow-2xl shadow-black/50 ${LIFT_GAP_COVER} ${currentRing}`}
        >
            <button
                type="button"
                role="radio"
                aria-checked={isCurrent}
                aria-label={rules.label}
                aria-describedby={`${taglineId} ${editionId} ${highlightsId}`}
                tabIndex={isTabStop ? 0 : -1}
                onFocus={() => onFocusRadio(rules.id)}
                onClick={() => onSelect(rules.id)}
                // The padding gives the focus ring room around the logo; the margin cancels it in the card.
                className={`-m-1 block w-[calc(100%+0.5rem)] flex-1 p-1 text-left text-white rounded-lg focus:outline-none ${radioFocusRing}`}
            >
                <ModeSummary rules={rules} isCurrent={isCurrent} taglineId={taglineId} editionId={editionId} highlightsId={highlightsId} />
            </button>
            <FullRulesButton rules={rules} onShowRules={onShowRules} />
        </motion.div>
    );
}

/**
 * The radio group. It unmounts when the overlay closes, so the tab stop starts on the current mode
 * each time it opens.
 */
function ModeRadioGroup({ value, prefersReducedMotion, onSelect, onShowRules }) {
    const [tabStopMode, setTabStopMode] = useState(value);

    return (
        <div
            role="radiogroup"
            aria-label="Game mode"
            onKeyDown={moveRadioFocus}
            className={MODE_GRID}
        >
            {GAME_MODES.map((rules) => (
                <ModeCard
                    key={rules.id}
                    rules={rules}
                    isCurrent={rules.id === value}
                    isTabStop={rules.id === tabStopMode}
                    prefersReducedMotion={prefersReducedMotion}
                    onFocusRadio={setTabStopMode}
                    onSelect={onSelect}
                    onShowRules={onShowRules}
                />
            ))}
        </div>
    );
}

function ReadOnlyModeList({ value, onShowRules }) {
    return (
        <div role="list" aria-label="Game modes" className={MODE_GRID}>
            {GAME_MODES.map((rules) => (
                <ReadOnlyModeCard
                    key={rules.id}
                    rules={rules}
                    isCurrent={rules.id === value}
                    onShowRules={onShowRules}
                />
            ))}
        </div>
    );
}

/**
 * The backdrop's light: from above, in the current mode's colours, falling away to dark. The mood's
 * gradient is the one the mode shift spreads, so the two read as the same light.
 */
function BackdropLight({ mode }) {
    return (
        <>
            <div
                style={/** @type {React.CSSProperties} */ ({ '--mode-shift-origin': '50% 0%', background: getRules(mode).mood.background })}
                className="absolute inset-0 opacity-40"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/20 to-black/70" />
        </>
    );
}

/**
 * The game modes as a full-screen overlay, on Home and over the room's logo. Radix handles the portal,
 * the focus trap, Escape, tapping the backdrop and returning focus to the trigger. A rules sheet opened
 * from "Full rules" stacks on top: Escape and taps go to the sheet, and closing it leaves this open.
 *
 * @param {object} props
 * @param {string} props.value  the current mode's id
 * @param {boolean} props.open
 * @param {(open: boolean) => void} props.onOpenChange
 * @param {(mode: string) => void} [props.onSelect]  a mode's radio was tapped
 * @param {(mode: string, button: HTMLElement) => void} props.onShowRules  a mode's "Full rules" was
 *        tapped. The button is where focus goes when the sheet closes.
 * @param {React.ReactElement} props.trigger  takes a ref and the trigger's props
 * @param {string} [props.readOnlyReason]  set for someone who can't change the mode: the overlay only
 *        shows the modes, and says this. With nothing to select, focus starts on Close.
 */
export default function GameModePicker({ value, open, onOpenChange, onSelect, onShowRules, trigger, readOnlyReason }) {
    const contentRef = useRef(null);
    const prefersReducedMotion = useReducedMotion();

    return (
        <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
            <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>
            <AnimatePresence>
                {open && (
                    <DialogPrimitive.Portal forceMount>
                        <DialogPrimitive.Overlay asChild forceMount>
                            <motion.div
                                data-testid="mode-picker-backdrop"
                                variants={BACKDROP_VARIANTS}
                                {...presenceProps(prefersReducedMotion)}
                                className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xl"
                            >
                                <BackdropLight mode={value} />
                            </motion.div>
                        </DialogPrimitive.Overlay>
                        <DialogPrimitive.Content
                            asChild
                            forceMount
                            onOpenAutoFocus={(event) => focusCurrentMode(event, contentRef)}
                        >
                            <motion.div
                                ref={contentRef}
                                variants={PANEL_VARIANTS}
                                {...presenceProps(prefersReducedMotion)}
                                // Centred by margins: framer-motion's transform would replace a translate.
                                className="fixed inset-0 z-50 m-auto flex h-fit max-h-[92dvh] w-[calc(100vw-1.5rem)] max-w-sm flex-col focus:outline-none md:max-w-4xl"
                            >
                                <motion.div variants={CARD_VARIANTS} className="mb-3 flex shrink-0 items-start justify-between gap-3 px-1 text-white">
                                    <div>
                                        <DialogPrimitive.Title className="text-xl font-black uppercase tracking-wide">
                                            {readOnlyReason ? 'Game modes' : 'Choose a game mode'}
                                        </DialogPrimitive.Title>
                                        <DialogPrimitive.Description className="mt-0.5 text-sm text-white/70">
                                            {readOnlyReason ?? 'How will your table play?'}
                                        </DialogPrimitive.Description>
                                    </div>
                                    <DialogPrimitive.Close
                                        aria-label="Close"
                                        className="shrink-0 rounded-full bg-white/10 p-2 hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                                    >
                                        <X className="w-5 h-5" aria-hidden="true" />
                                    </DialogPrimitive.Close>
                                </motion.div>
                                {readOnlyReason ? (
                                    <ReadOnlyModeList value={value} onShowRules={onShowRules} />
                                ) : (
                                    <ModeRadioGroup
                                        value={value}
                                        prefersReducedMotion={prefersReducedMotion}
                                        onSelect={onSelect}
                                        onShowRules={onShowRules}
                                    />
                                )}
                            </motion.div>
                        </DialogPrimitive.Content>
                    </DialogPrimitive.Portal>
                )}
            </AnimatePresence>
        </DialogPrimitive.Root>
    );
}
