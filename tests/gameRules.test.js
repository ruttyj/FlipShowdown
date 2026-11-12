// The game mode registry: what every mode must bring, and the pure rules around changing mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import colors from 'tailwindcss/colors.js';
import { SCAN_MODE_IDS } from '../server/src/scanModes.js';
import { calculateFlip7Score } from '../src/lib/flip7Scoring.js';
import {
    GAME_MODES,
    MODE_SHIFT_STYLE,
    usesCrossFade,
    canChangeMode,
    getRules,
    isKnownGameMode,
    modeChangeMessage,
    modeTransition,
    readLastGameMode,
    rememberGameMode,
    specialCardLabel,
} from '../src/lib/gameRules.js';

// --- Registry ------------------------------------------------------------------

test('a mode with a Bust step says what a bust means, and every mode what to do after submitting (X45)', () => {
    for (const mode of GAME_MODES) {
        // Only the Bust step shows the warning; elsewhere the tile busts without asking.
        assert.equal(typeof mode.bustWarning, mode.modifiersAfterBust ? 'string' : 'object');
        assert.equal(typeof mode.offersDuplicateOverride, 'boolean');
    }
    assert.equal(getRules('classic').bustWarning, null);
    assert.equal(getRules('classic').offersDuplicateOverride, false);
    assert.equal(getRules('vengeance').offersDuplicateOverride, true);
    assert.equal(getRules('classic').submittedReminder, null);
    assert.equal(getRules('vengeance').submittedReminder, 'If your cards change before the round ends, change your score.');
});

test('Brutal is offered, last, after the modes it builds on', () => {
    assert.deepEqual(GAME_MODES.map((mode) => mode.id), ['classic', 'vengeance', 'brutal']);
    assert.equal(isKnownGameMode('brutal'), true);
});

// The server reads an unknown scan mode as classic without a word, so a mode whose scanMode it
// didn't know would quietly get the wrong prompt.
test('the server knows every mode\'s scanMode', () => {
    for (const mode of GAME_MODES) {
        assert.ok(SCAN_MODE_IDS.includes(mode.scanMode), mode.id);
    }
});

test('Brutal is scanned with the Vengeance prompt', () => {
    assert.equal(getRules('brutal').scanMode, 'vengeance');
});

// --- Brutal -----------------------------------------------------------------------

test('Brutal says what it changes: the picker text, the bust warning, the start button', () => {
    const brutal = getRules('brutal');

    assert.equal(brutal.tagline, 'Vengeance with no mercy');
    assert.deepEqual(brutal.highlights, [
        'Vengeance cards',
        'Round score can go below 0',
        'Modifiers can hit busted players',
        'Flip 7: +15 for you or −15 for a rival',
    ]);
    assert.equal(brutal.startLabel, 'Start Brutal Game');
    assert.equal(brutal.canGoNegative, true);
    assert.equal(brutal.hasFlip7Attack, true);
    assert.equal(brutal.modifiersAfterBust, true);
    assert.equal(brutal.offersDuplicateOverride, true);
    assert.equal(brutal.wordmark.tag, 'Brutal');
    assert.doesNotMatch(brutal.bustWarning, /will be 0/);
});

test('only Brutal has a Flip 7 attack, modifiers after a bust and a wordmark tag', () => {
    for (const id of ['classic', 'vengeance']) {
        const rules = getRules(id);
        assert.equal(rules.hasFlip7Attack, false);
        assert.equal(rules.modifiersAfterBust, false);
        assert.equal(rules.wordmark.tag, undefined);
    }
});

test('Brutal rules that a minus card added after a bust is out of reach of Steal, Swap and Discard (X54)', () => {
    const { sections } = getRules('brutal').rulesContent;
    const openCases = sections.find((section) => section.title === 'Edge cases with no official answer');
    const text = openCases.items.join(' ');

    assert.match(text, /Steal, Swap and Discard still can't/);
    assert.match(text, /minus card added after a bust stays/);
    assert.match(text, /has no valid card to act on and is discarded/);
});

test('Vengeance says what Just One More! does to a player who stayed, as the publisher\'s rule (X55)', () => {
    const { sections } = getRules('vengeance').rulesContent;
    const itemsIn = (title) => sections.find((section) => section.title === title).items.join(' ');

    assert.match(itemsIn('Modifiers and actions'), /Just One More!.*already stayed/);
    assert.match(itemsIn('Edge cases the publisher has answered'), /Just One More! on a player who stayed.*can bust/);
    assert.doesNotMatch(itemsIn('Edge cases with no official answer'), /Just One More! on a player who/);
});

test('the Brutal deck is the Vengeance deck', () => {
    assert.deepEqual(getRules('brutal').addButtons, getRules('vengeance').addButtons);
    assert.deepEqual(getRules('brutal').specialCards, getRules('vengeance').specialCards);
});

test('the Brutal rules tab shows only what differs from Vengeance, with the rulings', () => {
    const brutal = JSON.stringify(getRules('brutal').rulesContent.sections);
    const vengeance = JSON.stringify(getRules('vengeance').rulesContent.sections);

    for (const point of [/below 0/, /Zero/, /busted/, /÷2/, /−15/]) {
        assert.match(brutal, point);
    }
    assert.equal(brutal.length < vengeance.length, true);
    assert.doesNotMatch(brutal, /Lucky 13/);
    assert.doesNotMatch(brutal, /48/);
});

// The Add a minus card row offers these, and a scan or the rulebook has no others.
test('a mode where modifiers reach a bust lists the minus cards to add', () => {
    assert.deepEqual(getRules('brutal').lateMinusCards, ['2', '4', '6', '8', '10']);
    assert.deepEqual(getRules('vengeance').lateMinusCards, []);
    assert.deepEqual(getRules('classic').lateMinusCards, []);
});

test('getRules reads a missing or unknown mode as classic', () => {
    assert.equal(getRules('vengeance').id, 'vengeance');
    assert.equal(getRules(undefined).id, 'classic');
    assert.equal(getRules(null).id, 'classic');
    assert.equal(getRules('brutal').id, 'brutal');
    assert.equal(getRules('not-a-mode').id, 'classic');
    assert.equal(getRules('constructor').id, 'classic');
});

const REQUIRED_FIELDS = [
    'id', 'label', 'tagline', 'highlights', 'addButtons', 'specialCards', 'scanMode', 'canGoNegative',
    'hasFlip7Attack', 'modifiersAfterBust', 'lateMinusCards', 'score', 'rulesContent', 'mood', 'wordmark', 'startLabel',
];

for (const mode of GAME_MODES) {
    test(`${mode.id} brings everything the registry promises`, () => {
        for (const field of REQUIRED_FIELDS) {
            assert.notEqual(mode[field], undefined, `${mode.id} has no ${field}`);
        }
        assert.equal(mode.highlights.length <= 4, true);
        assert.equal(typeof mode.score, 'function');
        assert.equal(mode.lateMinusCards.length > 0, mode.modifiersAfterBust);
        assert.equal(typeof mode.rulesContent.goal.before, 'string');
        assert.equal(typeof mode.rulesContent.goal.after, 'string');
        assert.equal(mode.rulesContent.sections.length > 0, true);
    });
}

test('the start button names the mode, and Classic stays "Start Game"', () => {
    assert.equal(getRules('classic').startLabel, 'Start Game');
    assert.equal(getRules('vengeance').startLabel, 'Start Vengeance Game');
    assert.equal(getRules('brutal').startLabel, 'Start Brutal Game');
});

test('the Vengeance deck\'s modes remind players to score once the round ends', () => {
    assert.equal(getRules('classic').entryReminder, null);
    assert.equal(getRules('vengeance').entryReminder, 'Score once the round ends, cards aren\'t safe until then.');
    assert.equal(getRules('brutal').entryReminder, getRules('vengeance').entryReminder);
});

test('specialCardLabel names each special and copes with an unknown one', () => {
    assert.equal(specialCardLabel('0'), 'The Zero');
    assert.equal(specialCardLabel('7'), 'Unlucky 7');
    assert.equal(specialCardLabel('13'), 'Lucky 13');
    assert.equal(specialCardLabel('5'), 'Special 5');
});

// The picker's words have to match what the scorer does (§3.13).
test('the Classic highlights match calculateFlip7Score', () => {
    const number = (value) => ({ type: 'number', value: String(value) });
    const highlights = getRules('classic').highlights.join(' | ');

    assert.match(highlights, /×2 and \+N/);
    assert.equal(calculateFlip7Score([number(10), { type: 'multiplier', value: '2' }]).finalScore, 20);
    assert.equal(calculateFlip7Score([number(10), { type: 'adder', value: '4' }]).finalScore, 14);

    assert.match(highlights, /duplicate number busts/i);
    assert.equal(calculateFlip7Score([number(4), number(4)]).isDuplicateBust, true);

    assert.match(highlights, /Flip 7 scores \+15/);
    assert.equal(calculateFlip7Score([1, 2, 3, 4, 5, 6, 7].map(number)).bonus, 15);
});

test('Classic links its own official PDF, not the Vengeance one', () => {
    const classicUrl = getRules('classic').rulesContent.sourceUrl;

    assert.match(classicUrl, /^https:\/\/.*\.pdf/);
    assert.notEqual(classicUrl, getRules('vengeance').rulesContent.sourceUrl);
});

test('the Vengeance rules carry the worked example and link the official PDF', () => {
    const { sections, sourceUrl } = getRules('vengeance').rulesContent;
    const text = JSON.stringify(sections);

    assert.match(text, /48/);
    assert.match(text, /35/);
    assert.match(sourceUrl, /^https:\/\/.*\.pdf/);
});

test('every mode has edge cases, and each links the FAQ for its own deck', () => {
    for (const mode of GAME_MODES) {
        const { sections, faqUrl } = mode.rulesContent;

        assert.equal(sections.some((section) => section.title === 'Edge cases with no official answer'), true, mode.id);
        assert.match(faqUrl, /^https:\/\/theop\.games\//, mode.id);
    }
    assert.notEqual(getRules('classic').rulesContent.faqUrl, getRules('vengeance').rulesContent.faqUrl);
});

test('Vengeance and Brutal open by comparing themselves with the mode they build on', () => {
    for (const [mode, baseLabel] of [['vengeance', 'Classic'], ['brutal', 'Vengeance']]) {
        const [changes] = getRules(mode).rulesContent.sections;

        assert.equal(changes.title, `What's changed from ${baseLabel}`);
        assert.equal(changes.baseLabel, baseLabel);
        for (const comparison of changes.comparisons) {
            assert.ok(comparison.topic && comparison.base && comparison.mode, comparison.topic);
        }
    }
    assert.equal(getRules('classic').rulesContent.sections.some((section) => section.comparisons), false);
});

// --- Theme, read from the stylesheet --------------------------------------------

const stylesheet = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

function themeBlock(selector) {
    const start = stylesheet.indexOf(selector);
    assert.notEqual(start, -1, `index.css has no ${selector} block`);
    return stylesheet.slice(start, stylesheet.indexOf('}', start));
}

function hexVariable(block, name) {
    const match = block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
    assert.notEqual(match, null, `theme has no ${name}`);
    return match[1];
}

function hexToRgb(hex) {
    return [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
}

function luminance(rgb) {
    const [red, green, blue] = rgb.map((channel) => {
        const unit = channel / 255;
        return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(firstRgb, secondRgb) {
    const lighter = Math.max(luminance(firstRgb), luminance(secondRgb));
    const darker = Math.min(luminance(firstRgb), luminance(secondRgb));
    return (lighter + 0.05) / (darker + 0.05);
}

/** The colour of `foreground` drawn at `opacity` over `background`. */
function blend(foreground, background, opacity) {
    return foreground.map((channel, index) => channel * opacity + background[index] * (1 - opacity));
}

const WHITE = [255, 255, 255];
const PULSE_PEAK_OPACITY = 0.6;
const ACCENT_SURFACES = ['--room-card', '--panel-header'];

for (const mode of GAME_MODES) {
    test(`${mode.id}'s room card fades through black, with AA white text at every stop`, () => {
        const block = themeBlock(`[data-game-mode='${mode.id}']`);
        const gradient = block.match(/--room-card-gradient:\s*([^;]+);/);
        assert.notEqual(gradient, null, 'theme has no --room-card-gradient');

        const stops = gradient[1].match(/#[0-9a-fA-F]{6}/g);
        assert.equal(stops.length, 3);
        assert.equal(stops[1], '#000000');
        assert.notEqual(stops[0], stops[2]);
        for (const stop of stops) {
            assert.ok(contrast(hexToRgb(stop), [255, 255, 255]) >= 4.5, `${stop} is under AA with white`);
        }
    });
}

// X62: a deeper version of the card's diagonal sits behind every room screen.
for (const mode of GAME_MODES) {
    test(`${mode.id}'s background is a diagonal gradient, with AA white text at every stop`, () => {
        const block = themeBlock(`[data-game-mode='${mode.id}']`);
        const gradient = block.match(/--game-bg-gradient:\s*linear-gradient\(135deg,([^;]+)\);/);
        assert.notEqual(gradient, null, 'theme has no diagonal --game-bg-gradient');

        const stops = gradient[1].match(/#[0-9a-fA-F]{6}/g);
        assert.equal(stops.length, 3);
        for (const stop of stops) {
            const ratio = contrast(WHITE, hexToRgb(stop));
            assert.ok(ratio >= 4.5, `${mode.id} background stop ${stop} contrast is ${ratio.toFixed(2)}`);
        }
    });
}

test('room screens draw the gradient over the flat background colour (X62)', () => {
    const rule = themeBlock('.game-screen-bg {');

    assert.match(rule, /background-color:\s*var\(--game-bg\);/);
    assert.match(rule, /background-image:\s*var\(--game-bg-gradient\);/);
});

for (const mode of GAME_MODES) {
    test(`${mode.id} has a theme with AA white text on its background`, () => {
        const block = themeBlock(`[data-game-mode='${mode.id}']`);

        const ratio = contrast(WHITE, hexToRgb(hexVariable(block, '--game-bg')));
        assert.equal(ratio >= 4.5, true, `${mode.id} --game-bg contrast is ${ratio.toFixed(2)}`);
    });

    test(`${mode.id} themes the room code card and the scoreboard header, with AA white text on them`, () => {
        const block = themeBlock(`[data-game-mode='${mode.id}']`);

        for (const surface of ACCENT_SURFACES) {
            const ratio = contrast(WHITE, hexToRgb(hexVariable(block, surface)));
            assert.equal(ratio >= 4.5, true, `${mode.id} ${surface} contrast is ${ratio.toFixed(2)}`);
        }
    });

    // X44: the muted-chat pulse has to stay visible on the background behind the toggles.
    test(`${mode.id}: the chat mute pulse is visible on the background at its peak`, () => {
        const block = themeBlock(`[data-game-mode='${mode.id}']`);
        const ring = hexToRgb(hexVariable(block, '--mute-pulse-color'));
        const background = hexToRgb(hexVariable(block, '--game-bg'));

        const ratio = contrast(blend(ring, background, PULSE_PEAK_OPACITY), background);
        assert.equal(ratio >= 3, true, `${mode.id} pulse contrast is ${ratio.toFixed(2)}`);
    });
}

test('brutal has no indigo left on the room code card or the scoreboard header', () => {
    const classic = themeBlock("[data-game-mode='classic']");
    const brutal = themeBlock("[data-game-mode='brutal']");

    for (const surface of ACCENT_SURFACES) {
        assert.notEqual(hexVariable(brutal, surface), hexVariable(classic, surface), surface);
    }
});

test('vengeance has its own plum surfaces, rose accent and red 7', () => {
    const classic = themeBlock("[data-game-mode='classic']");
    const vengeance = themeBlock("[data-game-mode='vengeance']");

    for (const token of ['--game-bg', '--room-card', '--panel-header', '--ui-accent', '--logo-accent']) {
        assert.notEqual(hexVariable(vengeance, token), hexVariable(classic, token), token);
    }
});

// --- Accent tokens (X41) --------------------------------------------------------

// Fixed colours that sit on the tinted token surfaces: quiet labels, numbers, bust and attack marks.
const SLATE_500 = colors.slate[500];
const SLATE_700 = colors.slate[700];
const RED_700 = colors.red[700];
const WHITE_HEX = '#ffffff';

// Every pair the UI draws, as [foreground, background]. A name starting with -- is a token.
const TEXT_PAIRS = [
    ['--ui-on-accent', '--ui-accent'],
    ['--ui-on-accent', '--ui-accent-strong'],
    ['--ui-on-accent-muted', '--ui-accent'],
    ['--ui-on-start', '--ui-start'],
    ['--ui-on-start', '--ui-start-hover'],
    ['--ui-accent', WHITE_HEX],
    ['--ui-accent', '--ui-accent-soft'],
    ['--ui-accent', '--ui-accent-soft-end'],
    ['--ui-accent-strong', WHITE_HEX],
    ['--ui-accent-strong', '--ui-accent-soft'],
    ['--ui-accent-strong', '--ui-accent-soft-end'],
    ['--ui-accent-strong', '--ui-accent-tint'],
    ['--ui-accent-deep', '--ui-accent-tint'],
    ['--ui-accent-deep', '--ui-accent-soft'],
    ['--ui-accent-ink', '--ui-accent-tint'],
    ['--ui-accent-vivid', WHITE_HEX],
    ['--ui-accent-vivid', '--ui-accent-soft'],
    [SLATE_500, '--ui-accent-soft'],
    [SLATE_500, '--ui-accent-soft-end'],
    [SLATE_700, '--ui-accent-soft'],
    [SLATE_700, '--ui-accent-tint'],
    [RED_700, '--ui-accent-soft'],
    [WHITE_HEX, '--tile-manual-start'],
    [WHITE_HEX, '--tile-manual-end'],
    [WHITE_HEX, '--tile-manual-hover'],
    [WHITE_HEX, '--tile-scan-start'],
    [WHITE_HEX, '--tile-scan-end'],
    [WHITE_HEX, '--tile-scan-hover-start'],
    [WHITE_HEX, '--tile-scan-hover-end'],
];

// Focus rings, drag and hover borders only need the 3:1 for UI, on the white card. The -border tokens
// aren't here: they edge a surface that also has text or an icon saying what it is, so they're decoration.
const UI_PAIRS = [
    ['--ui-accent-vivid', WHITE_HEX],
    ['--ui-accent-bright', WHITE_HEX],
];

// Classic has to keep today's exact look, and today's look has these gaps. They are listed so nothing
// new can join them, and the test below fails once one is fixed so the entry goes too.
const CLASSIC_INHERITED_GAPS = new Set([
    `--ui-on-accent-muted on --ui-accent`,
    `--ui-on-start on --ui-start`,
    `--ui-accent-vivid on ${WHITE_HEX}`,
    `--ui-accent-vivid on --ui-accent-soft`,
    `${SLATE_500} on --ui-accent-soft`,
    `${SLATE_500} on --ui-accent-soft-end`,
    `${WHITE_HEX} on --tile-manual-start`,
    `${WHITE_HEX} on --tile-manual-end`,
    `${WHITE_HEX} on --tile-manual-hover`,
    `${WHITE_HEX} on --tile-scan-start`,
    `${WHITE_HEX} on --tile-scan-hover-start`,
    `${WHITE_HEX} on --tile-scan-hover-end`,
]);
const CLASSIC_INHERITED_UI_GAP = '--ui-accent-bright';

function pairContrast(block, [foreground, background]) {
    const resolve = (name) => (name.startsWith('--') ? hexVariable(block, name) : name);
    return contrast(hexToRgb(resolve(foreground)), hexToRgb(resolve(background)));
}

for (const mode of GAME_MODES) {
    test(`${mode.id}: every accent token pair meets AA`, () => {
        const block = themeBlock(`[data-game-mode='${mode.id}']`);

        for (const pair of TEXT_PAIRS) {
            const name = `${pair[0]} on ${pair[1]}`;
            const isInheritedGap = mode.id === 'classic' && CLASSIC_INHERITED_GAPS.has(name);
            if (isInheritedGap) {
                continue;
            }
            const ratio = pairContrast(block, pair);
            assert.equal(ratio >= 4.5, true, `${mode.id} ${name} contrast is ${ratio.toFixed(2)}`);
        }

        for (const pair of UI_PAIRS) {
            const isInheritedGap = mode.id === 'classic' && pair[0] === CLASSIC_INHERITED_UI_GAP;
            if (isInheritedGap) {
                continue;
            }
            const ratio = pairContrast(block, pair);
            assert.equal(ratio >= 3, true, `${mode.id} ${pair[0]} on ${pair[1]} contrast is ${ratio.toFixed(2)}`);
        }
    });
}

test('the classic gaps listed as inherited are all still real', () => {
    const block = themeBlock("[data-game-mode='classic']");

    for (const pair of TEXT_PAIRS) {
        const name = `${pair[0]} on ${pair[1]}`;
        if (CLASSIC_INHERITED_GAPS.has(name)) {
            assert.equal(pairContrast(block, pair) < 4.5, true, `${name} now passes, so drop it from the list`);
        }
    }
    assert.equal(pairContrast(block, [CLASSIC_INHERITED_UI_GAP, WHITE_HEX]) < 3, true, CLASSIC_INHERITED_UI_GAP);
});

// Classic's tokens are the Tailwind shades the UI was written in, so it looks as it did.
test('classic\'s tokens hold the exact shades the UI had before it was themed', () => {
    const block = themeBlock("[data-game-mode='classic']");
    const expected = {
        '--ui-accent': colors.indigo[600],
        '--ui-accent-strong': colors.indigo[700],
        '--ui-accent-deep': colors.indigo[800],
        '--ui-accent-ink': colors.indigo[900],
        '--ui-accent-soft': colors.indigo[50],
        '--ui-accent-soft-end': colors.purple[50],
        '--ui-accent-tint': colors.indigo[100],
        '--ui-accent-border': colors.indigo[200],
        '--ui-accent-border-strong': colors.indigo[300],
        '--ui-accent-bright': colors.indigo[400],
        '--ui-accent-vivid': colors.indigo[500],
        '--ui-on-accent-muted': colors.indigo[300],
        '--ui-picker-surface': colors.slate[950],
        '--ui-start': colors.emerald[600],
        '--ui-start-hover': colors.emerald[700],
        '--tile-manual-start': colors.sky[500],
        '--tile-manual-end': colors.indigo[500],
        '--tile-manual-hover': colors.sky[400],
        '--tile-scan-start': colors.indigo[500],
        '--tile-scan-end': colors.violet[600],
        '--tile-scan-hover-start': colors.indigo[400],
        '--tile-scan-hover-end': colors.violet[500],
    };

    for (const [token, shade] of Object.entries(expected)) {
        assert.equal(hexVariable(block, token), shade, token);
    }
});

// With no attribute, Home's portalled dialogs and a room that has gone read these.
test('with no mode on the page, the accent tokens read as classic', () => {
    // The last :root is the themes' fallback: the ones before it are shadcn's.
    const fallbackStart = stylesheet.lastIndexOf(':root {');
    const fallback = stylesheet.slice(fallbackStart, stylesheet.indexOf('}', fallbackStart));
    const classic = themeBlock("[data-game-mode='classic']");

    for (const match of classic.matchAll(/(--(?:ui|tile)-[\w-]+):\s*([^;]+);/g)) {
        const [, token, value] = match;
        assert.equal(fallback.includes(`${token}: ${value};`), true, token);
    }
});

test('each themed mode sets every accent token', () => {
    const classic = themeBlock("[data-game-mode='classic']");
    const tokens = [...classic.matchAll(/(--(?:ui|tile)-[\w-]+):/g)].map((match) => match[1]);
    assert.equal(tokens.length > 0, true);

    for (const mode of GAME_MODES) {
        const block = themeBlock(`[data-game-mode='${mode.id}']`);
        for (const token of tokens) {
            assert.equal(block.includes(`${token}:`), true, `${mode.id} has no ${token}`);
        }
    }
});

// Home has no room to theme. Card type colours mean something, and are in the card editor.
// A vote button's blue means "others are voting, you aren't" (X52), so it can't follow the theme.
// The brand logo's soft FLIP is only drawn on Home and in the launcher, never in a room (X72).
const FILES_WITH_FIXED_BLUES = new Set([
    'pages/Home.jsx',
    'components/logo/Wordmark.jsx',
    'components/AccountBar.jsx',
    'components/game/CardListEditor.jsx',
    'components/game/HoldToVote.jsx',
]);

test('room screens use the tokens instead of a fixed blue or purple', () => {
    const sourceRoot = new URL('../src/', import.meta.url);

    for (const entry of fs.readdirSync(sourceRoot, { recursive: true })) {
        const file = String(entry).replaceAll('\\', '/');
        const isSource = file.endsWith('.js') || file.endsWith('.jsx');
        if (!isSource || FILES_WITH_FIXED_BLUES.has(file)) {
            continue;
        }

        const source = fs.readFileSync(new URL(file, sourceRoot), 'utf8');
        const fixedBlue = source.match(/\b(?:indigo|violet|purple|sky|blue)-\d+/);
        assert.equal(fixedBlue, null, `${file} has ${fixedBlue?.[0]}`);
    }
});

test('Brutal looks different from Vengeance', () => {
    const vengeance = themeBlock("[data-game-mode='vengeance']");
    const brutal = themeBlock("[data-game-mode='brutal']");

    assert.notEqual(hexVariable(brutal, '--game-bg'), hexVariable(vengeance, '--game-bg'));
    assert.notEqual(getRules('brutal').mood.background, getRules('vengeance').mood.background);
});

// §3.7: darker and faster than Vengeance's.
test('the Brutal mood is faster than Vengeance\'s', () => {
    const brutal = getRules('brutal').mood;
    const vengeance = getRules('vengeance').mood;

    assert.equal(brutal.coverMs < vengeance.coverMs, true);
});

// --- Changing mode -------------------------------------------------------------

test('the shift is the circle unless motion is reduced or the circle has been switched off', () => {
    assert.equal(usesCrossFade({ prefersReducedMotion: false, style: 'circle' }), false);
    assert.equal(usesCrossFade({ prefersReducedMotion: true, style: 'circle' }), true);
    assert.equal(usesCrossFade({ prefersReducedMotion: false, style: 'cross-fade' }), true);
    assert.equal(usesCrossFade({ prefersReducedMotion: false }), MODE_SHIFT_STYLE === 'cross-fade');
});

test('modeTransition fires only on a real change between two known modes', () => {
    assert.deepEqual(modeTransition('classic', 'vengeance'), { from: 'classic', to: 'vengeance' });
    assert.deepEqual(modeTransition('vengeance', 'classic'), { from: 'vengeance', to: 'classic' });
    assert.deepEqual(modeTransition('classic', 'brutal'), { from: 'classic', to: 'brutal' });
    assert.deepEqual(modeTransition('brutal', 'vengeance'), { from: 'brutal', to: 'vengeance' });
});

test('modeTransition ignores first load, refetch, rejoin and reopening', () => {
    // First load and rejoin: nothing known before.
    assert.equal(modeTransition(undefined, 'vengeance'), null);
    assert.equal(modeTransition(null, 'vengeance'), null);
    // Refetch and reopening a game: same mode.
    assert.equal(modeTransition('vengeance', 'vengeance'), null);
    // Leaving: nothing known after.
    assert.equal(modeTransition('vengeance', undefined), null);
    assert.equal(modeTransition('vengeance', 'not-a-mode'), null);
    assert.equal(modeTransition('not-a-mode', 'vengeance'), null);
});

test('the mode can change while waiting, and while playing with no scores at all', () => {
    assert.equal(canChangeMode({ status: 'waiting' }, []), true);
    assert.equal(canChangeMode({ status: 'playing' }, []), true);
    assert.equal(canChangeMode({ status: 'playing' }, [{ id: 's1' }]), false);
    assert.equal(canChangeMode({ status: 'finished' }, []), false);
    assert.equal(canChangeMode({ status: 'closed' }, []), false);
});

test('modeChangeMessage tells non-hosts the new mode, and anyone entering that cards re-scored', () => {
    const label = 'Vengeance';

    assert.equal(modeChangeMessage({ isHost: false, label, hasEntryOpen: false }), 'Host switched to Vengeance');
    assert.equal(
        modeChangeMessage({ isHost: false, label, hasEntryOpen: true }),
        'Host switched to Vengeance. Your cards were re-scored',
    );
    assert.equal(modeChangeMessage({ isHost: true, label, hasEntryOpen: true }), 'Your cards were re-scored');
    assert.equal(modeChangeMessage({ isHost: true, label, hasEntryOpen: false }), null);
});

// --- Last mode this device chose ------------------------------------------------

function memoryStorage() {
    const stored = new Map();
    return {
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key, value) => stored.set(key, value),
    };
}

test('the last chosen mode falls back to classic and rejects unknown values', () => {
    const storage = memoryStorage();

    assert.equal(readLastGameMode(storage), 'classic');
    rememberGameMode('vengeance', storage);
    assert.equal(readLastGameMode(storage), 'vengeance');
    rememberGameMode('brutal', storage);
    assert.equal(readLastGameMode(storage), 'brutal');
    storage.setItem('flip7_last_game_mode', JSON.stringify('not-a-mode'));
    assert.equal(readLastGameMode(storage), 'classic');
    storage.setItem('flip7_last_game_mode', 'not json');
    assert.equal(readLastGameMode(storage), 'classic');
});

test('with no storage at all the last mode is classic and remembering does nothing', () => {
    assert.equal(readLastGameMode(null), 'classic');
    assert.doesNotThrow(() => rememberGameMode('vengeance', null));
});
