import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CARD_TILT_DEGREES,
    DEFAULT_LOGO_FIT,
    SHOWDOWN_TRACKING_EM,
    TITLE_SIZE_EM,
    createCanvasMeasure,
    fitCard,
    fitLogo,
} from '../src/lib/logoFit.js';

// --- Builders -------------------------------------------------------------

// A monospaced stand-in font: each letter is 0.6em wide with 0.05em of side bearing on each side,
// capitals 0.7em tall. Letter spacing adds after every letter, as in a browser.
const ADVANCE = 0.6;
const BEARING = 0.05;
const CAP = 0.7;

function fakeMeasure(text, { letterSpacingEm }) {
    const advance = text.length * (ADVANCE + letterSpacingEm);
    const lastInkRight = (text.length - 1) * (ADVANCE + letterSpacingEm) + ADVANCE - BEARING;
    return { left: -BEARING, right: lastInkRight, advance, ascent: CAP };
}

function inkWidth(text, letterSpacingEm) {
    const metrics = fakeMeasure(text, { letterSpacingEm });
    return metrics.left + metrics.right;
}

function near(actual, expected, message) {
    assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} is not ${expected}`);
}

// --- The card -------------------------------------------------------------

test('the tilted card spans exactly the cap height', () => {
    const card = fitCard(0.7);
    const tilt = CARD_TILT_DEGREES * Math.PI / 180;

    near(card.widthEm * Math.sin(tilt) + card.heightEm * Math.cos(tilt), 0.7, 'tilted height');
    near(card.boxHeightEm, 0.7, 'box height');
    near(card.widthEm / card.heightEm, 5 / 7, 'card shape');
    near(card.boxWidthEm, card.widthEm * Math.cos(tilt) + card.heightEm * Math.sin(tilt), 'box width');
});

// --- Fitting --------------------------------------------------------------

test('SHOWDOWN is sized so its ink is exactly as wide as FLIP and the card', () => {
    const fit = fitLogo(fakeMeasure, []);

    const showdownInk = inkWidth('SHOWDOWN', SHOWDOWN_TRACKING_EM) * fit.showdown.fontSizeEm;
    near(showdownInk, fit.widthEm, 'SHOWDOWN ink width');
    assert.equal(fit.showdown.letterSpacingEm, SHOWDOWN_TRACKING_EM);
});

test('each title is spaced so its ink is exactly the logo\'s width', () => {
    const fit = fitLogo(fakeMeasure, ['Classic', 'Vengeance']);

    for (const title of ['Classic', 'Vengeance']) {
        const ink = inkWidth(title.toUpperCase(), fit.titles[title].letterSpacingEm) * TITLE_SIZE_EM;
        near(ink, fit.widthEm, `${title} ink width`);
    }
    assert.ok(fit.titles.Classic.letterSpacingEm > fit.titles.Vengeance.letterSpacingEm, 'the shorter word is spaced wider');
});

test('the margins trim each line\'s box to its ink', () => {
    const fit = fitLogo(fakeMeasure, ['Classic']);

    near(fit.flip.marginLeftEm, -BEARING, 'FLIP left');
    near(fit.showdown.marginLeftEm, -BEARING, 'SHOWDOWN left');
    // The box ends after the last letter's bearing and its trailing letter spacing.
    near(fit.showdown.marginRightEm, -(BEARING + SHOWDOWN_TRACKING_EM), 'SHOWDOWN right');
    near(fit.titles.Classic.marginRightEm, -(BEARING + fit.titles.Classic.letterSpacingEm), 'title right');
});

test('the card starts a fixed gap after the P\'s ink, and the logo\'s width runs to its far edge', () => {
    const fit = fitLogo(fakeMeasure, []);
    const flip = fakeMeasure('FLIP', { letterSpacingEm: -0.025 });

    const cardStart = flip.advance + fit.card.marginLeftEm;
    near(cardStart - flip.right, 0.07, 'gap between the P and the card');
    near(fit.widthEm, flip.left + cardStart + fit.card.boxWidthEm, 'width from the F\'s ink to the card\'s edge');
    near(fit.card.boxHeightEm, CAP, 'the card is as tall as the capitals');
});

test('the default fit names every mode title the logo shows', () => {
    assert.deepEqual(Object.keys(DEFAULT_LOGO_FIT.titles).sort(), ['Classic', 'Vengeance']);
    assert.ok(DEFAULT_LOGO_FIT.showdown.fontSizeEm > 0.3 && DEFAULT_LOGO_FIT.showdown.fontSizeEm < 0.45);
});

// --- Measuring with a canvas -------------------------------------------------

function fakeDocument(context) {
    return { createElement: () => ({ getContext: () => context }) };
}

test('without a canvas there is nothing to measure with', () => {
    const families = { logo: 'sans-serif', system: 'system-ui' };

    assert.equal(createCanvasMeasure(families, undefined), null);
    assert.equal(createCanvasMeasure(families, fakeDocument(null)), null);
    assert.equal(createCanvasMeasure(families, { createElement: () => ({}) }), null);
    // An old canvas without letter spacing can't measure tracked text.
    assert.equal(createCanvasMeasure(families, fakeDocument({ measureText() {} })), null);
});

test('the canvas measure sets the font and spacing, and reports in em', () => {
    const context = {
        font: '',
        letterSpacing: '0px',
        measureText(text) {
            this.measured = text;
            return { actualBoundingBoxLeft: -50, actualBoundingBoxRight: 2400, width: 2500, actualBoundingBoxAscent: 700 };
        },
    };
    const measure = createCanvasMeasure({ logo: 'Inter, sans-serif', system: 'system-ui' }, fakeDocument(context));

    const metrics = measure('FLIP', { weight: 900, letterSpacingEm: -0.025, family: 'logo' });

    assert.equal(context.font, '900 1000px Inter, sans-serif');
    assert.equal(context.letterSpacing, '-25px');
    assert.equal(context.measured, 'FLIP');
    assert.deepEqual(metrics, { left: -0.05, right: 2.4, advance: 2.5, ascent: 0.7 });

    measure('SHOWDOWN', { weight: 700, letterSpacingEm: 0.12, family: 'system' });
    assert.equal(context.font, '700 1000px system-ui');
});
