import { supportsStructuredOutput } from './aiModels.js';
import { isPlainObject } from './query.js';

// What to ask the model for a photo, and how to read its answer, for each scan mode. The client asks
// for a mode through its registry's `scanMode` (src/lib/gameRules.js). Whatever the model says, the
// client only ever gets { value, type } cards back.

// Anything beyond this is the model hallucinating; a Flip 7 hand is far smaller.
const MAX_CARDS = 40;

// --- Classic ---------------------------------------------------------------

// Base game plus Flip 7: With a Vengeance (the 13 card, ÷2 and the minus modifiers). Classic can't enter
// those by hand, but a scan still reads them so a forgotten mode switch gets the wrong-deck hint (X46, X57).
const NUMBER_VALUES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13'];
const MULTIPLIER_VALUES = ['x2'];
const DIVISOR_VALUES = ['÷2'];
const ADDER_VALUES = ['+2', '+4', '+6', '+8', '+10'];
const SUBTRACTOR_VALUES = ['-2', '-4', '-6', '-8', '-10'];

const CARD_TYPES_BY_VALUES = [
    { type: 'number', values: NUMBER_VALUES },
    { type: 'multiplier', values: MULTIPLIER_VALUES },
    { type: 'divisor', values: DIVISOR_VALUES },
    { type: 'adder', values: ADDER_VALUES },
    { type: 'subtractor', values: SUBTRACTOR_VALUES },
];

// The symbol each modifier type prints before its number.
const MODIFIER_PREFIXES = { multiplier: 'x', divisor: '÷', adder: '+', subtractor: '-' };

// Pinned by a hash in server/test/ai.test.js, so a forgotten mode switch keeps reading as it always
// has and the wrong-deck hint keeps working (X46).
const CLASSIC_PROMPT = `You are scoring a round of the card game Flip 7 from a photo of one player's cards. The photo should be from the base game, but the table may be using the Flip 7: With a Vengeance deck by mistake, so report what is printed.

The deck has three kinds of cards:
- Number cards: a single number from 0 to 12, or 13 in the Vengeance deck. They have a tan background and show both the number and the number written as a word (e.g. "SEVEN"); reading the word helps identify the number. Each number has its own text colour: 0 red, 1 gray, 2 lime, 3 red, 4 cyan, 5 green, 6 purple, 7 red, 8 green, 9 orange, 10 red, 11 blue, 12 gray, 13 blue.
- Modifier cards: an orange or red background with a symbol printed before the number:
  - "x2" multiplies the number-card total. Base game.
  - "+2", "+4", "+6", "+8", "+10" add points. Base game.
  - "÷2" divides the number-card total. It is always a division by 2, never a multiplication. Vengeance deck only.
  - "-2", "-4", "-6", "-8", "-10" subtract points. Vengeance deck only.
  Report a "÷2" or a minus card only when you can clearly see that symbol printed; a smudged or partly hidden symbol is most likely a "x" or a "+".
  Modifier cards never show 0: there is no "+0", "-0", "x0" or "÷0" card. If a modifier seems to read 0, look again; it is most likely an upside-down or partly hidden 6, 8 or 10.
- Action cards: "Freeze", "Flip Three", "Flip Four", "One More", "Steal" and "Second Chance". They score nothing. Ignore them completely.

Read carefully:
- A "+4" modifier and a "4" number card score very differently, so always check for the symbol and the card's background colour.
- If the symbol appears after the number, the card is upside down: "9+" is really "+6", "8+" is "+8", "01+" is "+10", "9-" is really "-6", "01-" is "-10".
- Any negative value is a subtract modifier.
- Cards may be rotated, upside down, overlapping or fanned out. Use each card's orientation to read it, and take care to tell 6 from 9 and 1 from 7.

List every number card and modifier card in front of the player:
- One entry per physical card. Include duplicates: two separate 7 cards are two entries.
- A card repeats its value in its corners; that is still one card.
- Ignore the face-down draw deck or discard pile in the background.
- Only list cards you can actually see. If there are no number or modifier cards, return an empty list.
- "value" is the number as digits ("0" to "13") or the modifier exactly as printed ("x2", "÷2", "+2" … "+10", "-2" … "-10").
- "type" is "number", "multiplier" (x2), "divisor" (÷2), "adder" (+ cards) or "subtractor" (- cards).

Double-check every card before answering.`;

// Constrains the model's JSON output (Gemini structured output, JSON Schema subset).
const CLASSIC_RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        cards: {
            type: 'array',
            description: 'Every scoring card visible in the photo, one entry per physical card.',
            items: {
                type: 'object',
                properties: {
                    value: {
                        type: 'string',
                        enum: CARD_TYPES_BY_VALUES.flatMap((entry) => entry.values),
                        description: 'Card value as printed, e.g. "7", "x2", "÷2", "+4" or "-6".',
                    },
                    type: {
                        type: 'string',
                        enum: CARD_TYPES_BY_VALUES.map((entry) => entry.type),
                    },
                },
                required: ['value', 'type'],
            },
        },
    },
    required: ['cards'],
};

// For models without structured output (Gemma), the format goes in the prompt instead.
const CLASSIC_JSON_FORMAT_INSTRUCTIONS = `

Answer with only a JSON object, no other text, in exactly this shape:
{"cards": [{"value": "7", "type": "number"}, {"value": "x2", "type": "multiplier"}, {"value": "÷2", "type": "divisor"}, {"value": "+4", "type": "adder"}, {"value": "-6", "type": "subtractor"}]}
Use {"cards": []} when there are no number or modifier cards.`;

/**
 * Spells a value the way the card lists do: "X 2" -> "x2", "×2" -> "x2",
 * "/2" -> "÷2", "−4" (Unicode minus) -> "-4".
 */
function canonicalValue(raw) {
    return raw
        .toLowerCase()
        .replace(/\s+/g, '')
        .replace(/^[×*]/, 'x')
        .replace(/^[/:]/, '÷')
        .replace(/^[−–]/, '-');
}

function cardTypeOf(value) {
    for (const entry of CARD_TYPES_BY_VALUES) {
        if (entry.values.includes(value)) {
            return entry.type;
        }
    }
    return null;
}

/**
 * A bare number the model labelled as a modifier: adds that modifier's symbol
 * when that makes a real card ({"4", adder} -> "+4"). Modifiers never show 0,
 * so a zero is a misread modifier and returns null. Otherwise it's most likely
 * a mislabelled number card ({"7", adder} -> "7"; there is no +7).
 */
function resolveUnsignedModifier(value, claimedPrefix) {
    const prefixed = claimedPrefix + value;
    if (cardTypeOf(prefixed)) {
        return prefixed;
    }
    if (Number(value) === 0) {
        return null;
    }
    return value;
}

/**
 * Normalises one card from the model's answer, or returns null to drop it.
 * The type is derived from the value rather than trusted, so a mislabelled
 * "+4" still scores as an adder. Zero modifiers don't exist and are dropped.
 * Examples: "X2" -> x2/multiplier, 7 -> "7"/number, "+ 4" -> "+4"/adder,
 * {"4", adder} -> "+4"/adder, {"0", adder} -> null, "+0" -> null, "Freeze" -> null.
 */
function normaliseClassicCard(entry) {
    if (!isPlainObject(entry)) {
        return null;
    }

    let raw = entry.value;
    if (typeof raw === 'number') {
        raw = String(raw);
    }
    if (typeof raw !== 'string') {
        return null;
    }

    let value = canonicalValue(raw);
    const claimedPrefix = MODIFIER_PREFIXES[entry.type];
    const isBareNumber = /^\d+$/.test(value);
    if (isBareNumber && claimedPrefix) {
        value = resolveUnsignedModifier(value, claimedPrefix);
        if (value === null) {
            return null;
        }
    }

    const type = cardTypeOf(value);
    if (!type) {
        return null;
    }
    return { value, type };
}

// --- Vengeance -------------------------------------------------------------

// Built for Gemini Flash-Lite and tuned on 7 real photos with server/eval/scanEval.js (X46). They have
// no overlapping cards, duplicates or -8, so measure again when photos of those exist.
const VENGEANCE_PROMPT = `You are reading one player's cards from a photo of the card game "Flip 7: With a Vengeance".
Your only job is to report which cards are in that player's line. Do not calculate anything.

STEP 1. Count the face-up cards belonging to the player and put the count in visible_card_count.
Include cards that are rotated sideways (a player who stays turns one card sideways), upside down,
overlapping or fanned. A card repeats its value in the corners; that is still one card.
Ignore face-down cards and piles of cards in the background.

STEP 2. For each card, copy the printed text you can see into printed_text, then choose its label
by checking these rules IN ORDER. Stop at the first match. Cards lie at any angle, so read the text
on the banner even when it is upside down, and always include a number card's word (e.g. "SIX").

1. Text "THE ZERO", "SCORE ZERO, UNLESS YOU FLIP 7" or a large 0 -> THE_ZERO
2. Text "UNLUCKY" or "DISCARD ALL OTHER CARDS" -> UNLUCKY_7
3. Text "LUCKY" or "YOU MAY HAVE ONE OTHER 13" -> LUCKY_13
4. A card with a banner naming "Just One More", "Swap", "Steal", "Discard" or "Flip Four" -> ACTION
5. A red card with a large symbol and text "THE SUM OF YOUR NUMBER CARDS" is a modifier, never ACTION,
   though it also says "PLAY ON ANY PLAYER". Read its symbol:
   "÷2" -> DIV_2, "-2" -> MINUS_2, "-4" -> MINUS_4, "-6" -> MINUS_6, "-8" -> MINUS_8, "-10" -> MINUS_10
6. Otherwise it is a plain number card: a single large number and the number as a word
   (e.g. "SEVEN"). Use the word to confirm the digits -> N_1 ... N_13

CHECK THESE BEFORE ANSWERING
- A 7 or 13 is only UNLUCKY_7 or LUCKY_13 if that sentence is printed on it. If the sentence is
  not visible and the card is fully visible, it is a plain N_7 or N_13.
- Modifiers: there is no x2, no plus card and no 0 modifier in this deck. If a modifier seems to
  read "-0", you are looking at part of "-10" or an upside-down digit. If a symbol comes after the
  number, the card is upside down: "9-" is -6, "01-" is -10.
- An upside-down 6 looks like a 9, and an upside-down 9 looks like a 6. The printed word decides, never
  the shape of the digits: "SIX" is N_6 and "NINE" is N_9. Tell 1 from 7 by the word as well.
- Two cards with the same number are two entries. Never merge them, and never remove a duplicate
  because it would break a game rule. Duplicates are legal to report.
- Only report what you can see. If there are no cards, return an empty list.`;

/** "N_1" -> { value: '1', type: 'number' }, up to 13. */
function plainNumberLabels() {
    const entries = [];
    for (let number = 1; number <= 13; number++) {
        entries.push([`N_${number}`, { value: String(number), type: 'number' }]);
    }
    return entries;
}

// The only labels that become a card. A Map, as a label is the model's text and an object lookup
// would find "constructor". Values are spelled as in the classic answer, because the client's
// sanitizeCard strips a modifier's symbol from both.
const VENGEANCE_CARDS_BY_LABEL = new Map([
    ...plainNumberLabels(),
    ['THE_ZERO', { value: '0', type: 'special' }],
    ['UNLUCKY_7', { value: '7', type: 'special' }],
    ['LUCKY_13', { value: '13', type: 'special' }],
    ['DIV_2', { value: '÷2', type: 'divisor' }],
    ['MINUS_2', { value: '-2', type: 'subtractor' }],
    ['MINUS_4', { value: '-4', type: 'subtractor' }],
    ['MINUS_6', { value: '-6', type: 'subtractor' }],
    ['MINUS_8', { value: '-8', type: 'subtractor' }],
    ['MINUS_10', { value: '-10', type: 'subtractor' }],
]);

// Action cards get a label of their own, or the model tends to force them into a scoring one.
const VENGEANCE_LABELS = [...VENGEANCE_CARDS_BY_LABEL.keys(), 'ACTION'];

// The properties are in the order the model should fill them in: counting before listing, and reading
// the text before choosing a label. propertyOrdering says so outright; gemini.js sends a schema as it
// is, and Google's API reference lists the field for JSON schemas.
const VENGEANCE_RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        visible_card_count: {
            type: 'integer',
            description: 'How many face-up cards belong to the player.',
        },
        cards: {
            type: 'array',
            description: 'Every face-up card of the player, one entry per physical card.',
            items: {
                type: 'object',
                properties: {
                    printed_text: {
                        type: 'string',
                        description: 'The text printed on the card, as far as it can be read.',
                    },
                    label: {
                        type: 'string',
                        enum: VENGEANCE_LABELS,
                    },
                },
                required: ['printed_text', 'label'],
                propertyOrdering: ['printed_text', 'label'],
            },
        },
    },
    required: ['visible_card_count', 'cards'],
    propertyOrdering: ['visible_card_count', 'cards'],
};

const VENGEANCE_JSON_FORMAT_INSTRUCTIONS = `

Answer with only a JSON object, no other text, in exactly this shape:
{"visible_card_count": 2, "cards": [{"printed_text": "SEVEN", "label": "N_7"}, {"printed_text": "YOU MAY HAVE ONE OTHER 13", "label": "LUCKY_13"}]}
Each label must be exactly one of: ${VENGEANCE_LABELS.join(', ')}.
Use {"visible_card_count": 0, "cards": []} when there are no cards.`;

/**
 * Which of 6 or 9 a card's printed text names, or null unless it names exactly one of them. Only this
 * pair, as it's the one a turned card confuses, and other number words appear in a card's other text
 * ("YOU MAY HAVE ONE OTHER 13").
 * Examples: "SIX" -> "6", "nine 9" -> "9", "6" -> null, "SIX NINE" -> null.
 */
function sixOrNineFromPrintedWord(printedText) {
    if (typeof printedText !== 'string') {
        return null;
    }

    const words = printedText.toUpperCase().split(/[^A-Z]+/);
    const saysSix = words.includes('SIX');
    const saysNine = words.includes('NINE');
    if (saysSix === saysNine) {
        return null;
    }
    return saysSix ? '6' : '9';
}

/**
 * Maps one labelled card to { value, type }, or returns null to drop it. That covers ACTION, and x2,
 * +N or anything else outside the deck: guessing a sign or a value would score a card nobody holds.
 * Gemma has no schema holding it to the labels, so a label's case and outer spaces don't matter.
 * On a 6 or 9 the printed word beats the label, because on real photos the model reads the word
 * correctly but can still label a turned card as the other one (X46).
 * Examples: "LUCKY_13" -> 13/special, " n_5 " -> 5/number, "ACTION" -> null, "PLUS_4" -> null,
 * { printed_text: "SIX", label: "N_9" } -> 6/number.
 */
function normaliseVengeanceCard(entry) {
    if (!isPlainObject(entry) || typeof entry.label !== 'string') {
        return null;
    }

    const card = VENGEANCE_CARDS_BY_LABEL.get(entry.label.trim().toUpperCase());
    if (!card) {
        return null;
    }

    const isSixOrNine = card.type === 'number' && (card.value === '6' || card.value === '9');
    if (isSixOrNine) {
        const printedNumber = sixOrNineFromPrintedWord(entry.printed_text);
        if (printedNumber) {
            return { ...card, value: printedNumber };
        }
    }
    return { ...card };
}

// --- Registry --------------------------------------------------------------

const CLASSIC_SCAN = {
    prompt: CLASSIC_PROMPT,
    schema: CLASSIC_RESPONSE_SCHEMA,
    formatInstructions: CLASSIC_JSON_FORMAT_INSTRUCTIONS,
    normaliseCard: normaliseClassicCard,
};

const VENGEANCE_SCAN = {
    prompt: VENGEANCE_PROMPT,
    schema: VENGEANCE_RESPONSE_SCHEMA,
    formatInstructions: VENGEANCE_JSON_FORMAT_INSTRUCTIONS,
    normaliseCard: normaliseVengeanceCard,
};

// A Map, as `mode` is whatever the client sent, and an object lookup would find "constructor".
const SCAN_MODES = new Map([
    ['classic', CLASSIC_SCAN],
    ['vengeance', VENGEANCE_SCAN],
    // Brutal is played with the Vengeance deck.
    ['brutal', VENGEANCE_SCAN],
]);

export const SCAN_MODE_IDS = Object.freeze([...SCAN_MODES.keys()]);

/**
 * The scan mode for what a client sent. Missing or unknown is classic, never an error: a client
 * ahead of or behind this server still gets a scan.
 *
 * @param {unknown} mode
 */
export function getScanMode(mode) {
    return SCAN_MODES.get(mode) ?? CLASSIC_SCAN;
}

/** The generateJson request for `model`: schema-constrained when the model supports it. */
export function buildScanRequest(model, image, scanMode) {
    if (supportsStructuredOutput(model)) {
        return { model, image, prompt: scanMode.prompt, schema: scanMode.schema };
    }
    return { model, image, prompt: scanMode.prompt + scanMode.formatInstructions };
}

/** Returns the clean card list, or null when the answer isn't shaped like { cards: [] }. */
export function normaliseScanResult(result, scanMode) {
    if (!isPlainObject(result) || !Array.isArray(result.cards)) {
        return null;
    }

    const cards = [];
    for (const entry of result.cards.slice(0, MAX_CARDS)) {
        const card = scanMode.normaliseCard(entry);
        if (card) {
            cards.push(card);
        }
    }
    return cards;
}
