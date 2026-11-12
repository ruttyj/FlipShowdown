import React, { forwardRef } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import { BrandWordmark, ModeWordmark } from '@/components/logo/Wordmark';
import { getRules } from '@/lib/gameRules';

const LOGO_ENTRANCE = {
    initial: { opacity: 0, y: -10 },
    animate: { opacity: 1, y: 0 },
};

// The logo is one lockup, drawn once in em and scaled by this font size, so every size is an exact copy.
// `modeTag` is the tag's size, 5/11 of the logo's, in px as it has to stay readable in the 56 px chip.
const SIZES = {
    tiny: { font: 'text-[22px]', modeTag: 'text-[10px]' },
    small: { font: 'text-[33px]', modeTag: 'text-[15px]' },
    medium: { font: 'text-[44px]', modeTag: 'text-[20px]' },
    large: { font: 'text-[66px] md:text-[77px]', modeTag: 'text-[30px] md:text-[35px]' },
};

const BRAND_NAME = 'Flip Showdown';

/** The words a mode's logo shows, as one string, e.g. "Flip Vengeance Brutal". */
function wordmarkText(mode) {
    const { wordmark } = getRules(mode);
    return ['Flip', wordmark.title, wordmark.tag].filter(Boolean).join(' ');
}

/** The brand's lockup or the mode's, at a size. */
function Wordmark({ mode, size, isBrand = false }) {
    const sizing = SIZES[size];
    if (isBrand) {
        return <BrandWordmark fontClass={sizing.font} />;
    }
    return <ModeWordmark mode={mode} fontClass={sizing.font} tagClass={sizing.modeTag} />;
}

/**
 * The game logo (X72). The brand version is the app's name, Flip Showdown, for Home, where no room
 * has a mode yet; otherwise the logo is in the mode's look and names it. A missing or unknown mode
 * reads as classic. A tiny or small logo is a preview of the mode rather than the page's heading, and
 * takes no entrance animation.
 *
 * @param {object} props
 * @param {string} [props.mode]
 * @param {'tiny'|'small'|'medium'|'large'} [props.size]
 * @param {string} [props.className]
 * @param {boolean} [props.isBrand]
 */
export default function GameLogo({ mode, size = 'medium', className = 'text-center mb-4 sm:mb-6', isBrand = false }) {
    const isPreview = size === 'tiny' || size === 'small';
    if (isPreview) {
        return <Wordmark mode={mode} size={size} />;
    }

    return (
        <motion.div data-game-logo {...LOGO_ENTRANCE} className={className}>
            <h1 aria-label={isBrand ? BRAND_NAME : wordmarkText(mode)}>
                <Wordmark mode={mode} size={size} isBrand={isBrand} />
            </h1>
        </motion.div>
    );
}

/**
 * The logo as the way into the mode overlay. It only opens the overlay and never switches mode itself,
 * because a stray tap mid-round must not change the rules. Used as the overlay's trigger, which
 * passes the click handler, aria-expanded and focus return through `triggerProps` and `ref`.
 * `action` ends the button's name, and says what the overlay lets this person do.
 *
 * The button's name starts with the words on it, so saying what is on screen activates it (WCAG
 * 2.5.3). Without its own label, the h1 would take the button's whole name as the page's heading.
 */
export const GameLogoButton = forwardRef(/** @type {React.ForwardRefRenderFunction<HTMLButtonElement, {mode?: string|null, action?: string} & React.ButtonHTMLAttributes<HTMLButtonElement>>} */ (function GameLogoButton({ mode, action = 'Change mode', ...triggerProps }, ref) {
    const logoText = wordmarkText(mode);

    return (
        <motion.div data-game-logo {...LOGO_ENTRANCE}>
            <h1 aria-label={logoText}>
                <button
                    ref={ref}
                    type="button"
                    aria-label={`${logoText}. Game mode: ${getRules(mode).label}. ${action}`}
                    className="group inline-flex items-center gap-1 rounded-xl px-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                    {...triggerProps}
                >
                    <Wordmark mode={mode} size="medium" />
                    <ChevronDown
                        className="w-5 h-5 text-white/70 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
                        aria-hidden="true"
                    />
                </button>
            </h1>
        </motion.div>
    );
}));
