// The rule kernel: the game's facts, what each mode allows, and what a final hand is worth. The client
// and the server both import this file, so it holds no words for players, styling, browser or Node
// APIs, and it imports nothing. The client's registry (src/lib/gameRules.js) adds a mode's words and looks.
//
// The client scores hands and the server trusts the result (server/src/gameActions/scoring.js). The
// server only calls isFlip7Hand, because an attack moves another player's score.

// --- Facts --------------------------------------------------------------------

/** What a Flip 7 is worth: added to the hand, or taken from a rival in a mode with attacks (X43). */
export const FLIP7_POINTS = 15;
export const FLIP_SEVEN_SIZE = 7;
/** The server rejects a round with more cards than this. */
export const MAX_CARDS_PER_ROUND = 30;

const LUCKY_NUMBER = 13;
const TOO_MANY_NUMBERS_WARNING = 'More than 7 number cards, so no bonus. Check your cards.';

/**
 * @typedef {object} ScoreOptions
 * @property {boolean} [busted]  the player declared a bust: the mode's bust score whatever the cards
 * @property {boolean} [duplicateAllowed]  a duplicate came from a Steal or Swap, so it isn't a bust.
 *           Only in a mode with those cards: Classic has none, so its scorer ignores this.
 * @property {boolean} [flip7Attack]  a Flip 7's 15 goes against another player, so the hand gets no
 *           bonus. The rival's total is the server's to change (X43).
 */

/**
 * @typedef {object} HandScore
 * @property {number} baseSum  the number cards added up
 * @property {number} multiplier  x2 and ÷2 combined
 * @property {number} adder  +N and −N combined
 * @property {number} bonus  15 for a Flip 7
 * @property {number} finalScore
 * @property {boolean} isDuplicateBust  busted because of the numbers in the hand
 * @property {boolean} isBust  busted, either from the numbers or because the player declared it
 * @property {boolean} zeroed  The Zero took the score to 0
 * @property {boolean} flooredAtZero  the minus cards went below 0 and the floor stopped them
 * @property {string[]} warnings  things to check, shown with the score
 */

// --- Reading a hand ------------------------------------------------------

// An empty or whitespace-only number row is an unfilled row, not a 0 card.
function isBlank(value) {
    return String(value ?? '').trim() === '';
}

/**
 * The digits in a modifier's value: "x2" -> 2, "÷2" -> 2, "-10" -> 10. The card
 * type carries the sign (X34), so an adder "-4" still adds 4. Modifier cards never
 * show 0, so no digits or a 0 ("÷0") give `fallback` instead.
 */
function modifierAmount(value, fallback) {
    const digits = String(value ?? '').replace(/[^0-9]/g, '');
    return parseInt(digits, 10) || fallback;
}

/** A special card scores as a number with its value (§3.4). */
function isNumberCard(card) {
    return card.type === 'number' || card.type === 'special';
}

function readNumberCard(hand, card) {
    if (isBlank(card.value)) {
        return;
    }

    const parsed = parseInt(card.value, 10);
    const value = parsed || 0;
    hand.numbers.push(value);
    hand.baseSum += value;

    // parsed, not value: "abc" counts as 0 points (X2) but it isn't a printed 0.
    if (parsed === 0) {
        hand.hasZero = true;
    }
    if (card.type === 'special' && value === LUCKY_NUMBER) {
        hand.hasLucky = true;
    }
}

function readModifierCard(hand, card) {
    if (card.type === 'multiplier') {
        hand.multiplier *= modifierAmount(card.value, 2);
    } else if (card.type === 'divisor') {
        hand.multiplier /= modifierAmount(card.value, 2);
    } else if (card.type === 'adder') {
        hand.adder += modifierAmount(card.value, 0);
    } else if (card.type === 'subtractor') {
        const amount = modifierAmount(card.value, 0);
        hand.adder -= amount;
        hand.minusTotal += amount;
    }
}

/** The hand's totals. Unknown card types add nothing. */
function readHand(cards) {
    const hand = {
        numbers: [],
        baseSum: 0,
        multiplier: 1,
        adder: 0,
        minusTotal: 0,
        hasZero: false,
        hasLucky: false,
    };

    for (const card of cards) {
        if (isNumberCard(card)) {
            readNumberCard(hand, card);
        } else {
            readModifierCard(hand, card);
        }
    }
    return hand;
}

function hasRepeatedNumber(numbers) {
    return new Set(numbers).size < numbers.length;
}

// --- Results -------------------------------------------------------------

/** The score of a busted hand: `finalScore` and how it busted change, the rest is empty. */
function bustResult({ finalScore, adder, isDuplicateBust }) {
    return {
        baseSum: 0,
        multiplier: 1,
        adder,
        bonus: 0,
        finalScore,
        isDuplicateBust,
        isBust: true,
        zeroed: false,
        flooredAtZero: false,
        warnings: [],
    };
}

function notBustFields() {
    return { isDuplicateBust: false, isBust: false };
}

// --- Classic -------------------------------------------------------------

/**
 * The base game: number cards sum to baseSum, which is multiplied (x2) or divided (÷2), then
 * adders/subtractors and the 7-card bonus apply. Two equal number cards bust. Blank number rows
 * are ignored, and the score may be negative (X1). Division can leave a fraction, so the final
 * score rounds down.
 *
 * @param {{type: string, value: string}[]} cards
 * @param {ScoreOptions} [options]
 * @returns {HandScore}
 */
export function scoreClassic(cards, { busted = false } = {}) {
    if (busted) {
        return bustResult({ finalScore: 0, adder: 0, isDuplicateBust: false });
    }

    const { numbers, baseSum, multiplier, adder } = readHand(cards);
    if (hasRepeatedNumber(numbers)) {
        return bustResult({ finalScore: 0, adder: 0, isDuplicateBust: true });
    }

    const bonus = numbers.length === FLIP_SEVEN_SIZE ? FLIP7_POINTS : 0;
    const finalScore = Math.floor((baseSum * multiplier) + adder + bonus);

    return {
        baseSum,
        multiplier,
        adder,
        bonus,
        finalScore,
        ...notBustFields(),
        zeroed: false,
        flooredAtZero: false,
        warnings: [],
    };
}

// --- Vengeance -----------------------------------------------------------

/** Lucky 13 lets its holder keep one other 13; a third still busts, as does any other repeat. */
function breaksDuplicateRule({ numbers, hasLucky }) {
    const others = numbers.filter((value) => value !== LUCKY_NUMBER);
    const thirteenCount = numbers.length - others.length;
    const allowedThirteens = hasLucky ? 2 : 1;
    return hasRepeatedNumber(others) || thirteenCount > allowedThirteens;
}

/**
 * How many cards count toward the seven: seven different numbers, so an overridden duplicate
 * doesn't count, except that Lucky 13 and the 13 it allows count as two.
 */
function countTowardSeven({ numbers, hasLucky }) {
    const differentNumbers = new Set(numbers).size;
    const hasLuckyPair = hasLucky && numbers.filter((value) => value === LUCKY_NUMBER).length > 1;
    return hasLuckyPair ? differentNumbers + 1 : differentNumbers;
}

/** Only the minus cards count on a bust where modifiers can still arrive; ÷2 has no effect. */
function vengeanceBust(hand, { modifiersAfterBust, isDuplicateBust }) {
    const adder = modifiersAfterBust ? 0 - hand.minusTotal : 0;
    return bustResult({ finalScore: adder, adder, isDuplicateBust });
}

/**
 * The rulebook's order: add the numbers, halve and round down, subtract, stop at 0, then add 15
 * for a Flip 7. The bonus comes after the floor, which is not the same as flooring the total.
 * The Zero makes the score 0 unless the hand is a Flip 7.
 *
 * The last two options come from the mode's capabilities, for the modes that bend these rules.
 *
 * @param {{type: string, value: string}[]} cards
 * @param {ScoreOptions & {canGoNegative?: boolean, modifiersAfterBust?: boolean}} [options]
 * @returns {HandScore}
 */
export function scoreVengeance(cards, options = {}) {
    const { busted = false, duplicateAllowed = false, flip7Attack = false, canGoNegative = false, modifiersAfterBust = false } = options;
    const hand = readHand(cards);

    if (busted) {
        return vengeanceBust(hand, { modifiersAfterBust, isDuplicateBust: false });
    }
    if (breaksDuplicateRule(hand) && !duplicateAllowed) {
        return vengeanceBust(hand, { modifiersAfterBust, isDuplicateBust: true });
    }

    const { baseSum, multiplier, adder, hasZero } = hand;
    const sevenCount = countTowardSeven(hand);
    const isFlipSeven = sevenCount === FLIP_SEVEN_SIZE;
    const warnings = sevenCount > FLIP_SEVEN_SIZE ? [TOO_MANY_NUMBERS_WARNING] : [];
    const shared = { baseSum, multiplier, adder, ...notBustFields(), warnings };

    if (hasZero && !isFlipSeven) {
        return { ...shared, bonus: 0, finalScore: 0, zeroed: true, flooredAtZero: false };
    }

    const afterModifiers = Math.floor(baseSum * multiplier) + adder;
    const flooredAtZero = !canGoNegative && afterModifiers < 0;
    const subtotal = flooredAtZero ? 0 : afterModifiers;
    const bonus = isFlipSeven && !flip7Attack ? FLIP7_POINTS : 0;

    return { ...shared, bonus, finalScore: subtotal + bonus, zeroed: false, flooredAtZero };
}

/**
 * Whether a hand under Vengeance's cards is a Flip 7: seven different numbers, counting Lucky 13 and
 * the 13 it allows as two, with no repeat unless the player said it came from a Steal or Swap (X45).
 * The server checks this before an attack, as that moves someone else's score (X43).
 *
 * @param {{value: string, type: string}[]} cards
 * @param {{duplicateAllowed?: boolean}} [options]
 */
export function isFlip7Hand(cards, { duplicateAllowed = false } = {}) {
    const hand = readHand(cards);

    if (breaksDuplicateRule(hand) && !duplicateAllowed) {
        return false;
    }
    return countTowardSeven(hand) === FLIP_SEVEN_SIZE;
}

// --- Mode capabilities ---------------------------------------------------

export const DEFAULT_GAME_MODE = 'classic';

const VENGEANCE_DECK = {
    addButtons: ['divisor', 'subtractor'],
    specialCards: ['0', '7', '13'],
    scanMode: 'vengeance',
    offersDuplicateOverride: true,
    score: scoreVengeance,
};

/**
 * What each mode allows, in the order the picker shows them.
 *
 * - addButtons: the modifier types the card editor offers
 * - specialCards: the special card values the mode has, which the card editor also offers
 * - scanMode: what to ask the scanner for
 * - canGoNegative: a round score can go below 0
 * - hasFlip7Attack: a Flip 7 can take 15 from a rival instead of adding 15
 * - modifiersAfterBust: modifiers can still reach a busted player
 * - lateMinusCards: the minus card values the bust panel can add, empty without modifiersAfterBust
 * - offersDuplicateOverride: a duplicate can be vouched for as coming from a Steal or Swap, so the
 *   mode needs those cards
 * - score: (cards, options) => HandScore
 */
const MODE_CAPABILITIES = [
    {
        id: 'classic',
        addButtons: ['multiplier', 'adder'],
        specialCards: [],
        scanMode: 'classic',
        canGoNegative: true,
        hasFlip7Attack: false,
        modifiersAfterBust: false,
        lateMinusCards: [],
        offersDuplicateOverride: false,
        score: scoreClassic,
    },
    {
        id: 'vengeance',
        ...VENGEANCE_DECK,
        canGoNegative: false,
        hasFlip7Attack: false,
        modifiersAfterBust: false,
        lateMinusCards: [],
    },
    {
        id: 'brutal',
        ...VENGEANCE_DECK,
        canGoNegative: true,
        hasFlip7Attack: true,
        modifiersAfterBust: true,
        lateMinusCards: ['2', '4', '6', '8', '10'],
    },
];

export const GAME_MODE_IDS = Object.freeze(MODE_CAPABILITIES.map((mode) => mode.id));

/** @param {unknown} mode */
export function isKnownGameMode(mode) {
    return MODE_CAPABILITIES.some((entry) => entry.id === mode);
}

/**
 * What `mode` allows. Stored rooms have no migration, so missing or unknown reads as classic.
 *
 * @param {unknown} mode
 */
export function modeCapabilities(mode) {
    const entry = MODE_CAPABILITIES.find((candidate) => candidate.id === mode);
    if (entry) {
        return entry;
    }
    return MODE_CAPABILITIES.find((candidate) => candidate.id === DEFAULT_GAME_MODE);
}

/**
 * Scores one player's round from their final hand under the room's mode. A missing or unknown mode
 * scores as classic.
 *
 * @param {{type: string, value: string}[]} cards
 * @param {unknown} [mode]
 * @param {ScoreOptions} [options]
 * @returns {HandScore}
 */
export function scoreHand(cards, mode, options = {}) {
    const capabilities = modeCapabilities(mode);
    return capabilities.score(cards, {
        ...options,
        flip7Attack: capabilities.hasFlip7Attack && options.flip7Attack === true,
        canGoNegative: capabilities.canGoNegative,
        modifiersAfterBust: capabilities.modifiersAfterBust,
    });
}
