// Fits the logo's lines to one width (X72): FLIP and the card set it, and SHOWDOWN and the mode
// titles are fitted to it, so every line's ink starts and ends at the same edges. The logo uses the
// device's own font, so the browser measures that font with a canvas; where it can't (tests, no
// canvas), DEFAULT_LOGO_FIT is used, balanced between Segoe UI and Roboto.
//
// Every value is in em of the font size it applies to, so a fit holds at every logo size.

export const CARD_TILT_DEGREES = 12;
const CARD_ASPECT = 5 / 7;
const CARD_GAP_EM = 0.07;
export const FLIP_TRACKING_EM = -0.025;
export const SHOWDOWN_TRACKING_EM = 0.12;
// The titles' size, as a fraction of the logo's.
export const TITLE_SIZE_EM = 0.395;
const MEASURE_SIZE_PX = 1000;

/**
 * @typedef {object} InkMetrics  in em of the measured font size
 * @property {number} left     how far the ink starts left of the text's origin (negative: right of it)
 * @property {number} right    where the ink ends, right of the origin
 * @property {number} advance  the width the text takes in a line, letter spacing included
 * @property {number} ascent   the ink's height above the baseline
 *
 * @typedef {(text: string, options: { weight: number, letterSpacingEm: number, family: 'logo'|'system' }) => InkMetrics} Measure
 *
 * @typedef {object} LineFit
 * @property {number} letterSpacingEm
 * @property {number} marginLeftEm   trims the side bearing, so the box starts at the ink
 * @property {number} marginRightEm  trims the side bearing and the last letter's spacing
 *
 * @typedef {object} LogoFit
 * @property {number} widthEm  every line's ink width, in em of the logo
 * @property {{ marginLeftEm: number }} flip
 * @property {{ boxWidthEm: number, boxHeightEm: number, widthEm: number, heightEm: number, marginLeftEm: number }} card
 * @property {LineFit & { fontSizeEm: number }} showdown
 * @property {Record<string, LineFit>} titles  by the title as written, e.g. 'Classic'
 */

/** The margins that make a line's box exactly its ink. */
function inkMargins(metrics) {
    return {
        marginLeftEm: metrics.left,
        marginRightEm: metrics.right - metrics.advance,
    };
}

function inkWidth(metrics) {
    return metrics.left + metrics.right;
}

/**
 * The card after FLIP, sized so its tilted outline runs from the cap line to the baseline.
 * @param {number} capEm
 */
export function fitCard(capEm) {
    const tilt = CARD_TILT_DEGREES * Math.PI / 180;
    const heightEm = capEm / (CARD_ASPECT * Math.sin(tilt) + Math.cos(tilt));
    const widthEm = heightEm * CARD_ASPECT;
    return {
        boxWidthEm: widthEm * Math.cos(tilt) + heightEm * Math.sin(tilt),
        boxHeightEm: capEm,
        widthEm,
        heightEm,
    };
}

/**
 * Fits every line to FLIP and the card.
 * @param {Measure} measure
 * @param {string[]} titles  the mode titles, as written (shown in capitals)
 * @returns {LogoFit}
 */
export function fitLogo(measure, titles) {
    const flip = measure('FLIP', { weight: 900, letterSpacingEm: FLIP_TRACKING_EM, family: 'logo' });
    const card = fitCard(flip.ascent);
    // The card starts CARD_GAP_EM after the P's ink, whatever the P's side bearing and FLIP's
    // trailing letter spacing leave between the ink and the end of the word.
    const cardMarginLeftEm = flip.right + CARD_GAP_EM - flip.advance;
    const widthEm = inkWidth(flip) + CARD_GAP_EM + card.boxWidthEm;

    const showdown = measure('SHOWDOWN', { weight: 700, letterSpacingEm: SHOWDOWN_TRACKING_EM, family: 'system' });

    return {
        widthEm,
        flip: { marginLeftEm: flip.left },
        card: { ...card, marginLeftEm: cardMarginLeftEm },
        showdown: {
            fontSizeEm: widthEm / inkWidth(showdown),
            letterSpacingEm: SHOWDOWN_TRACKING_EM,
            ...inkMargins(showdown),
        },
        titles: Object.fromEntries(titles.map((title) => [title, fitTitle(measure, title, widthEm)])),
    };
}

/** A title's letter spacing, so its ink is `widthEm` of the logo wide at TITLE_SIZE_EM. */
function fitTitle(measure, title, widthEm) {
    const text = title.toUpperCase();
    const plain = measure(text, { weight: 900, letterSpacingEm: 0, family: 'logo' });
    const letterSpacingEm = (widthEm / TITLE_SIZE_EM - inkWidth(plain)) / (text.length - 1);
    const spaced = measure(text, { weight: 900, letterSpacingEm, family: 'logo' });
    return { letterSpacingEm, ...inkMargins(spaced) };
}

/**
 * The fit where the font can't be measured: the mean of Segoe UI's and Roboto's, so it is off by a
 * few percent on either rather than exact on one. Measured with fitLogo on 2026-11-08.
 * @type {LogoFit}
 */
export const DEFAULT_LOGO_FIT = {
    widthEm: 2.55,
    flip: { marginLeftEm: -0.055 },
    card: { ...fitCard(0.71), marginLeftEm: 0.075 },
    showdown: { fontSizeEm: 0.373, letterSpacingEm: SHOWDOWN_TRACKING_EM, marginLeftEm: -0.031, marginRightEm: -0.188 },
    titles: {
        Classic: { letterSpacingEm: 0.41, marginLeftEm: -0.031, marginRightEm: -0.436 },
        Vengeance: { letterSpacingEm: 0.07, marginLeftEm: 0.008, marginRightEm: -0.086 },
    },
};

/**
 * Measures text with a canvas in the given font stacks, or returns null where there is no canvas
 * (jsdom, a server).
 * @param {{ logo: string, system: string }} families  CSS font-family lists
 * @param {Document | undefined} [doc]
 * @returns {Measure | null}
 */
export function createCanvasMeasure(families, doc = globalThis.document) {
    const context = doc?.createElement('canvas').getContext?.('2d');
    if (!context || !('letterSpacing' in context)) {
        return null;
    }

    return (text, { weight, letterSpacingEm, family }) => {
        context.font = `${weight} ${MEASURE_SIZE_PX}px ${families[family]}`;
        context.letterSpacing = `${letterSpacingEm * MEASURE_SIZE_PX}px`;
        const metrics = context.measureText(text);
        return {
            left: metrics.actualBoundingBoxLeft / MEASURE_SIZE_PX,
            right: metrics.actualBoundingBoxRight / MEASURE_SIZE_PX,
            advance: metrics.width / MEASURE_SIZE_PX,
            ascent: metrics.actualBoundingBoxAscent / MEASURE_SIZE_PX,
        };
    };
}
