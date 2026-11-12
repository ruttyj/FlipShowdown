import React, { useState } from 'react';
import { GAME_MODES, getRules } from '@/lib/gameRules';
import { CARD_TILT_DEGREES, DEFAULT_LOGO_FIT, TITLE_SIZE_EM, createCanvasMeasure, fitLogo } from '@/lib/logoFit';

// The logo's two lockups (X72): the brand (FLIP and the card over SHOWDOWN) for Home and the
// launcher, and a room's (FLIP and the card over the mode's title). Spans only, so either can sit
// inside a button. Each is one column drawn in em, so every size is an exact copy, and every line is
// fitted to FLIP and the card (src/lib/logoFit.js).

// One column, one gap between its lines. Each line's box is trimmed to its capitals, so that gap is
// the space seen between the letters, whatever line heights the font brings.
const LOCKUP = 'grid justify-center justify-items-center gap-y-[0.15em] whitespace-nowrap text-center';
const CAPS_BOX = 'leading-[0.72] [text-box:trim-both_cap_alphabetic]';
const CARD = 'absolute left-1/2 top-1/2 rounded-[0.06em] bg-[color:var(--logo-accent)] shadow-[inset_0_0_0_0.018em_rgba(255,255,255,0.45)]';
// FLIP's colour: plain white in a room, where the title under it carries the colour; on the brand logo a
// soft fade from near-white into SHOWDOWN's pale indigo, so it doesn't glare on Home's dark stage (X72).
const FLIP_WHITE = 'text-white';
const FLIP_SOFT = 'bg-gradient-to-b from-indigo-50 to-indigo-200 bg-clip-text text-transparent';
const MODE_TITLES = [...new Set(GAME_MODES.map((rules) => rules.wordmark.title))];

let measuredFit = null;

/** The fit in this device's font, measured once; the default where there is no canvas. */
function readLogoFit() {
    if (measuredFit) {
        return measuredFit;
    }
    const measure = createCanvasMeasure({ logo: getComputedStyle(document.body).fontFamily, system: 'system-ui' });
    measuredFit = measure ? fitLogo(measure, MODE_TITLES) : DEFAULT_LOGO_FIT;
    return measuredFit;
}

function useLogoFit() {
    const [fit] = useState(readLogoFit);
    return fit;
}

/** A fitted line's spacing and side trims, as inline styles in the line's own em. */
function lineStyle(lineFit) {
    return {
        letterSpacing: `${lineFit.letterSpacingEm}em`,
        marginLeft: `${lineFit.marginLeftEm}em`,
        marginRight: `${lineFit.marginRightEm}em`,
    };
}

/** FLIP and the tilted card: the first line of both lockups. The card is decoration only. */
function FlipLine({ fit, colorClass = FLIP_WHITE }) {
    const { card } = fit;
    return (
        <span style={{ marginLeft: `${fit.flip.marginLeftEm}em` }} className={`font-black tracking-tight ${colorClass} ${CAPS_BOX}`}>
            FLIP
            <span
                aria-hidden="true"
                data-logo-card
                style={{ width: `${card.boxWidthEm}em`, height: `${card.boxHeightEm}em`, marginLeft: `${card.marginLeftEm}em` }}
                className="relative inline-block align-baseline"
            >
                <span
                    style={{
                        width: `${card.widthEm}em`,
                        height: `${card.heightEm}em`,
                        transform: `translate(-50%, -50%) rotate(${CARD_TILT_DEGREES}deg)`,
                    }}
                    className={CARD}
                />
            </span>
        </span>
    );
}

/**
 * The app's name: FLIP and the card over SHOWDOWN in the pale --logo-sub. Home and the launcher.
 * @param {{ fontClass: string }} props  the logo's font size, e.g. 'text-[22px]'
 */
export function BrandWordmark({ fontClass }) {
    const fit = useLogoFit();
    const { showdown } = fit;

    return (
        <span className={`${LOCKUP} ${fontClass}`}>
            <FlipLine fit={fit} colorClass={FLIP_SOFT} />
            <span
                style={{
                    fontFamily: 'system-ui',
                    color: 'var(--logo-sub)',
                    fontSize: `${showdown.fontSizeEm}em`,
                    ...lineStyle(showdown),
                }}
                className={`font-bold uppercase ${CAPS_BOX}`}
            >
                Showdown
            </span>
        </span>
    );
}

/**
 * A mode's tag as a slanted bar the width of the logo, so the logo doesn't pinch in at a short word.
 * The side margins are what the slant adds, so its corners meet the edges.
 */
function TagBar({ tag, tagClass }) {
    return (
        <span className="mx-[0.07em] justify-self-stretch -skew-x-12 bg-red-700 py-[0.1em]">
            <span className={`block skew-x-12 font-black uppercase tracking-wide text-white ${CAPS_BOX} ${tagClass}`}>
                {tag}
            </span>
        </span>
    );
}

/**
 * A room's logo: FLIP and the card over the mode's title in its look, and its tag if it has one. No
 * SHOWDOWN: that is the brand's alone.
 * @param {{ mode?: string | null, fontClass: string, tagClass: string }} props
 */
export function ModeWordmark({ mode, fontClass, tagClass }) {
    const fit = useLogoFit();
    const { wordmark } = getRules(mode);

    return (
        <span className={`${LOCKUP} ${fontClass}`}>
            <FlipLine fit={fit} />
            <span
                style={{ fontSize: `${TITLE_SIZE_EM}em`, ...lineStyle(fit.titles[wordmark.title]) }}
                className={`font-black uppercase ${CAPS_BOX} ${wordmark.titleClass}`}
            >
                {wordmark.title}
            </span>
            {wordmark.tag && <TagBar tag={wordmark.tag} tagClass={tagClass} />}
        </span>
    );
}

