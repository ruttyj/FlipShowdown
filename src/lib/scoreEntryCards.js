// Helpers for the card list of a manual score entry.

import { CARD_TYPES } from './flip7Scoring.js';
import { getRules, specialCardLabel } from './gameRules.js';

export { MAX_CARDS_PER_ROUND } from '../../shared/rules.js';

const FLIP_SEVEN_CARDS = 7;
const SPECIAL_TYPE = 'special';
// How the type picker names a special card, whose value decides which card it is.
const SPECIAL_OPTION_PREFIX = `${SPECIAL_TYPE}:`;
const ZERO_VALUE = '0';
// A typed 0: "0" or "00", not "10" or "".
const ONLY_ZEROS = /^0+$/;

function isBlank(value) {
    return String(value ?? '').trim() === '';
}

/** A new unfilled row of the given card type (a number row by default). */
export function createEmptyCard(type = 'number') {
    return { value: '', type };
}

/**
 * A card as it is being typed. A modifier's type carries its sign, so its value keeps only the
 * digits (X34): "x2" -> "2", "÷2" -> "2", "+4" -> "4", "-6" -> "6". That is what lets every value
 * field be a number input. A special's value is digits too. Number cards are left alone, since a
 * number card may be negative (X1).
 *
 * @param {{type: string, value: string}} card
 */
export function sanitizeTypedCard(card) {
    if (card.type === 'number') {
        return card;
    }

    const digits = String(card.value ?? '').replace(/[^0-9]/g, '');
    return { ...card, value: digits };
}

/**
 * A card once it is settled: sanitizeTypedCard, and a 0 in a mode with The Zero becomes that card,
 * because the deck has no other 0. That isn't done while typing, as it replaces the field and closes
 * the phone's keyboard, and deleting the 1 from "10" passes through a 0 (see CardListEditor).
 *
 * @param {{type: string, value: string}} card
 * @param {string} [mode]  the room's game mode
 */
export function sanitizeCard(card, mode) {
    if (card.type !== 'number') {
        return sanitizeTypedCard(card);
    }

    const isTypedZero = ONLY_ZEROS.test(String(card.value ?? '').trim());
    if (isTypedZero && getRules(mode).specialCards.includes(ZERO_VALUE)) {
        return { ...card, type: SPECIAL_TYPE, value: ZERO_VALUE };
    }
    return card;
}

/**
 * @param {{type: string, value: string}[]} cards
 * @param {string} [mode]  the room's game mode
 */
export function sanitizeCards(cards, mode) {
    return cards.map((card) => sanitizeCard(card, mode));
}

/** The rows to show first: restored cards when there are any, otherwise one empty row. */
export function startingCards(initialCards, mode) {
    if (initialCards && initialCards.length > 0) {
        return sanitizeCards(initialCards, mode);
    }
    return [createEmptyCard()];
}

/**
 * The cards after Enter in a row of `type`: a blank last row becomes that type (X34), so it never
 * leaves a stray blank row; otherwise a new empty row is appended.
 */
export function addCard(cards, type) {
    const lastCard = cards[cards.length - 1];
    if (lastCard && isBlank(lastCard.value)) {
        return [...cards.slice(0, -1), createEmptyCard(type)];
    }
    return [...cards, createEmptyCard(type)];
}

/** The cards after Add card is tapped. Blank rows are dropped later, on Confirm (see dropBlankCards). */
export function addNextCard(cards) {
    return [...cards, createEmptyCard()];
}

/** Whether a type option is a special card already in the hand, as a deck has only one of each. */
export function isTypeOptionTaken(cards, option) {
    const isSpecialOption = option.startsWith(SPECIAL_OPTION_PREFIX);
    return isSpecialOption && cards.some((card) => cardTypeOption(card) === option);
}

/**
 * The cards that count and are sent: rows with an empty or whitespace-only value
 * are dropped for every type, since a blank multiplier or divisor would still
 * score as x2 or ÷2.
 */
export function dropBlankCards(cards) {
    return cards.filter((card) => !isBlank(card.value));
}

/**
 * The rows that go over a Flip 7: number and special cards after the seventh, which can't happen in
 * play as the seventh ends the round. Blank rows and modifiers don't count, as in the scoring.
 *
 * @param {{type: string, value: string}[]} cards
 * @returns {Set<number>} their indexes
 */
export function cardsPastSeven(cards) {
    const pastSeven = new Set();
    let numberCount = 0;
    cards.forEach((card, index) => {
        const isNumberCard = card.type === 'number' || card.type === SPECIAL_TYPE;
        if (!isNumberCard || isBlank(card.value)) {
            return;
        }

        numberCount += 1;
        if (numberCount > FLIP_SEVEN_CARDS) {
            pastSeven.add(index);
        }
    });
    return pastSeven;
}

// --- The row's type picker ---------------------------------------------------

function specialOption(value) {
    return { value: `${SPECIAL_OPTION_PREFIX}${value}`, label: specialCardLabel(value) };
}

/** The picker's value for a row: its type, or which special card it is. */
export function cardTypeOption(card) {
    if (card.type === SPECIAL_TYPE) {
        return `${SPECIAL_OPTION_PREFIX}${card.value}`;
    }
    return card.type;
}

/** The picker's entry for a row's own type, for a row whose type the mode may not offer. */
function ownTypeOption(card) {
    if (card.type === SPECIAL_TYPE) {
        return specialOption(card.value);
    }
    const known = CARD_TYPES.find((cardType) => cardType.value === card.type);
    return known ?? { value: card.type, label: card.type };
}

/**
 * What a row's type picker offers in this mode. A mode narrows what can be added, but a row
 * restored from a draft keeps its own type on the list, so it stays editable and isn't changed by
 * just opening the editor.
 *
 * @param {string} mode
 * @param {{type: string, value: string}} card  the row
 * @returns {{value: string, label: string}[]}
 */
export function cardTypeOptions(mode, card) {
    const { addButtons, specialCards } = getRules(mode);

    const options = [];
    for (const cardType of CARD_TYPES) {
        if (cardType.value === 'number' || addButtons.includes(cardType.value)) {
            options.push(cardType);
        }
    }
    for (const value of specialCards) {
        options.push(specialOption(value));
    }

    const rowOption = cardTypeOption(card);
    if (!options.some((option) => option.value === rowOption)) {
        options.push(ownTypeOption(card));
    }
    return options;
}

/** The value a special card leaves behind when its row becomes `type`. */
function valueLeftBySpecial(card, type) {
    const keepsNumber = type === 'number' && card.value !== ZERO_VALUE;
    return keepsNumber ? card.value : '';
}

/**
 * The row after a choice in its type picker.
 *
 * @param {{type: string, value: string}} card
 * @param {string} option  a value from cardTypeOptions
 * @param {string} mode
 */
export function retypeCard(card, option, mode) {
    if (option.startsWith(SPECIAL_OPTION_PREFIX)) {
        return { ...card, type: SPECIAL_TYPE, value: option.slice(SPECIAL_OPTION_PREFIX.length) };
    }
    if (card.type === SPECIAL_TYPE) {
        return { ...card, type: option, value: valueLeftBySpecial(card, option) };
    }
    return sanitizeCard({ ...card, type: option }, mode);
}

/**
 * The cards after a type button is tapped for the row at `index`. A special card has no value of its
 * own, so choosing one for a row that has a value adds it as a new row, rather than losing that value.
 *
 * @param {{type: string, value: string}[]} cards
 * @param {number} index  the row the button acts on
 * @param {string} option  a value from cardTypeOptions
 * @param {string} mode
 * @returns {{cards: {type: string, value: string}[], index: number}} also the row it ended up in
 */
export function switchCardType(cards, index, option, mode) {
    const isSpecialOption = option.startsWith(SPECIAL_OPTION_PREFIX);
    if (isSpecialOption && !isBlank(cards[index].value)) {
        const specialCard = retypeCard(createEmptyCard(), option, mode);
        return { cards: [...sanitizeCards(cards, mode), specialCard], index: cards.length };
    }

    const updated = [...cards];
    updated[index] = retypeCard(cards[index], option, mode);
    return { cards: updated, index };
}
