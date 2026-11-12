// The single place the client asks about a game mode. GAME_MODES is an ordered list that the picker,
// rules sheet, theme and scoring all read: each entry is the mode's capabilities from the rule kernel
// (shared/rules.js) plus its words and looks. So a further mode is one new entry there and here, plus
// its theme block in src/index.css. Nothing outside these files may assume how many modes there are.

import { DEFAULT_GAME_MODE, isKnownGameMode, modeCapabilities } from '../../shared/rules.js';
import { getLocalStorage, readJson, writeJson } from './safeStorage.js';

export { isKnownGameMode };

const LAST_GAME_MODE_KEY = 'flip7_last_game_mode';
const CLASSIC_RULEBOOK_URL = 'https://cdn.shopify.com/s/files/1/0611/3958/3198/files/25_FLIP_7_TB_RULES_C_Rev_9_2_25_ND.pdf?v=1756935535';
const VENGEANCE_RULEBOOK_URL = 'https://cdn.shopify.com/s/files/1/0611/3958/3198/files/26_FLIP_7_VENGEANCE_RULES_C.pdf?v=1770853609';

// --- Special cards ---------------------------------------------------------

// { type: 'special', value } cards by value. The type carries the meaning, the value stays digits (X34).
const SPECIAL_CARD_LABELS = {
    0: 'The Zero',
    7: 'Unlucky 7',
    13: 'Lucky 13',
};

/** @param {string} value  a special card's value */
export function specialCardLabel(value) {
    return SPECIAL_CARD_LABELS[value] ?? `Special ${value}`;
}

// --- Rules text, in our own words --------------------------------------------

// The app only scores final hands, so nothing here is enforced. Edge cases are split by who answered
// them: the publisher (rulebook or FAQ), or nobody, where the text is a suggestion for the table.
const TABLE_RULINGS_NOTE = 'The rulebook and FAQ don\'t settle these. This is what we suggest, and your table has the final say. The app only scores final hands, so it won\'t stop you playing them differently.';
const CLASSIC_FAQ_URL = 'https://theop.games/pages/flip-7-faqs';
const VENGEANCE_FAQ_URL = 'https://theop.games/pages/flip-7-wav-faqs';

const CLASSIC_RULES = {
    // The words either side of the room's target score, which the rules sheet shows between them.
    goal: { before: 'Be the player with the most points once someone reaches ', after: ' at the end of a round.' },
    sections: [
        {
            title: 'Your turn',
            items: [
                'Take another card (hit), or stop and bank what you have (stay).',
                'A second copy of a number you already hold is a bust: you score nothing this round.',
                'Seven different numbers is a Flip 7, which ends the round.',
            ],
        },
        {
            title: 'Scoring',
            items: [
                'Add your number cards.',
                'A ×2 card doubles that sum, but nothing else.',
                'Add any +N cards.',
                'A Flip 7 adds 15 on top.',
            ],
        },
        {
            title: 'Action cards',
            items: [
                'Freeze: the target has to stay right now.',
                'Flip Three: the target takes the next three cards.',
                'Second Chance: throw away one duplicate instead of busting.',
            ],
        },
        {
            title: 'Edge cases the publisher has answered',
            items: [
                'Whoever is dealt an Action card chooses its target: any active player, or themselves. Active means you haven\'t stayed or busted.',
                'No one else active? You must play the Action card on yourself, even a Freeze.',
                'An Action card in the opening deal pauses the deal until it is resolved. So some players can have no cards while others have three or four.',
                'You can stay with any card in front of you. With no cards at all, you can\'t.',
                'A hand of only modifiers scores them, but a ×2 on its own is worth nothing.',
                'Flip Three stops early on a Flip 7 or a bust. Every card flipped counts toward the three.',
                'A Freeze or Flip Three revealed during a Flip Three waits until all three are flipped, and is ignored if the player busted. It can then go to any active player.',
                'A Second Chance revealed during a Flip Three can be used straight away on the rest of those cards.',
                'A Second Chance can\'t block a Freeze. It only stops a duplicate number.',
                'After a Second Chance saves you, you don\'t flip again until your next turn.',
                'A second Second Chance goes to another active player without one. If there is nobody to give it to, it is discarded.',
                'Unused Second Chances are discarded at the end of the round, including after a Freeze or a Flip 7.',
                'Deck ran out mid-round? Shuffle only the discards into a new deck. Cards in front of players stay put, even a busted player\'s.',
                'A tie for the most points at 200 or more: the FAQ says keep playing rounds until there is one winner. This app ends the game and names the player earlier in the turn order.',
            ],
        },
        {
            title: 'Edge cases with no official answer',
            note: TABLE_RULINGS_NOTE,
            items: [
                'Frozen in the opening deal before getting a card: you are out with 0, and the deal skips you.',
                'Given a Flip Three before your opening card: flip the three, then still take your card from the deal if you are active.',
                'A Flip 7 ends the round at once, so any Action card still waiting is discarded.',
                'Several Action cards waiting after a Flip Three: resolve them in the order they were flipped, and stop if the round ends.',
                'A waiting Action card whose flipper has no one else to give it to goes on the flipper, including a Freeze.',
                'A duplicate cancelled by a Second Chance during a Flip Three still counts as one of the three cards.',
                'A second Second Chance revealed during a Flip Three is passed on before the next card is flipped.',
                'Deck and discards both empty (very rare, and more likely with many players): no one can hit, so everyone still active stays and the round ends. Use a second deck above 18 players, as the rulebook advises.',
            ],
        },
    ],
    sourceUrl: CLASSIC_RULEBOOK_URL,
    faqUrl: CLASSIC_FAQ_URL,
};

const VENGEANCE_RULES = {
    goal: { before: 'Be the player with the most points once someone has ', after: ' or more at the end of a round.' },
    sections: [
        {
            title: 'What\'s changed from Classic',
            note: 'The big idea: staying no longer makes you safe. Nothing is banked until the round ends, and other players can reach into your hand until then.',
            baseLabel: 'Classic',
            comparisons: [
                {
                    topic: 'Staying',
                    base: 'You leave the round and bank your points.',
                    mode: 'You turn your leftmost card sideways and your cards stay in the round. You stop hitting, but you can still be targeted.',
                },
                {
                    topic: 'When your points are safe',
                    base: 'As soon as you stay or are frozen.',
                    mode: 'Only when the round ends, so wait until then to enter your score.',
                },
                {
                    topic: 'Who can be targeted',
                    base: 'Active players only. Anyone who stayed or busted is out of reach.',
                    mode: 'Anyone who hasn\'t busted, including players who stayed or were forced to stay. Being hit by an Action card doesn\'t bring a stayed player back into the round.',
                },
                {
                    topic: 'Modifier cards',
                    base: '+2 to +10 and ×2. You keep them, and they raise your score.',
                    mode: '−2 to −10 and ÷2. You play them on any player who hasn\'t busted, and they lower that score. You only keep one if you are the last player who hasn\'t busted.',
                },
                {
                    topic: 'Action cards',
                    base: 'Freeze, Flip Three and Second Chance.',
                    mode: 'Just One More!, Swap, Steal, Discard and Flip Four!. Each is used once and then discarded. If it has a valid card to act on, it must be used, even when that hurts you.',
                },
                {
                    topic: 'Protection from a bust',
                    base: 'Second Chance cancels a duplicate.',
                    mode: 'There is no Second Chance. The closest thing is Lucky 13, which only covers 13s.',
                },
                {
                    topic: 'Forcing someone to stop',
                    base: 'Freeze stops them at once.',
                    mode: 'There is no Freeze. Just One More! makes them take one more card and then stay, so it can bust them or help them.',
                },
                {
                    topic: 'Forcing someone to flip',
                    base: 'Flip Three, on an active player.',
                    mode: 'Flip Four!, on anyone who hasn\'t busted. A player who stayed can be forced to flip, can bust, and stays out of the round if they survive.',
                },
                {
                    topic: 'How you can bust',
                    base: 'Only by flipping a duplicate yourself.',
                    mode: 'Also through other players: a Swap or Steal that gives you a duplicate busts you, and one Swap can bust two players at once.',
                },
                {
                    topic: 'Losing cards',
                    base: 'Cards in front of you stay yours until the round ends.',
                    mode: 'Face-up cards can be stolen, swapped or discarded, including Special Number cards. Busted cards are face down and out of play, so they can\'t be touched.',
                },
                {
                    topic: 'The deck',
                    base: '94 cards. Numbers 0 to 12, with a plain 0 worth nothing.',
                    mode: '108 cards. Numbers 1 to 13, plus three Special Number cards: The Zero, Unlucky 7 and Lucky 13.',
                },
                {
                    topic: 'The zero card',
                    base: 'Worth nothing, but helps you reach seven.',
                    mode: 'Your whole score is 0 unless you Flip 7, and you have to keep hitting on your turn.',
                },
                {
                    topic: 'Scoring order',
                    base: 'Add numbers, double with ×2, add +N cards, add 15 for a Flip 7.',
                    mode: 'Add numbers, halve with ÷2 and round down, take off −N cards but stop at 0, add 15 for a Flip 7.',
                },
                {
                    topic: 'The opening deal',
                    base: 'Only Action cards pause the deal.',
                    mode: 'Action and Modifier cards both pause it, and are resolved right away. The deal starts on the dealer\'s left.',
                },
            ],
            items: [
                'Still the same: first to the target ends the game at the end of that round, a duplicate number busts, a Flip 7 ends the round at once for +15, the deal passes left, and discards aren\'t reshuffled until the deck runs out.',
            ],
        },
        {
            title: 'Your turn',
            items: [
                'Take another card (hit), or stop and turn one card sideways (stay).',
                'A second copy of a number you hold is a bust: your cards go out of play.',
                'Only enter your score when the round is over. Even after staying, you can lose cards and be handed minus cards.',
            ],
        },
        {
            title: 'Scoring',
            items: [
                'Add your number cards.',
                'Holding ÷2? Halve that and round down.',
                'Take off your minus cards. This step can\'t go below 0.',
                'A Flip 7 adds 15 last.',
                'Example: 48 becomes 24 with ÷2, then 20 with −4, then 35 with a Flip 7.',
            ],
        },
        {
            title: 'Special numbers',
            items: [
                'The Zero: you score 0 unless you Flip 7. It counts as one of the seven, and you have to keep hitting.',
                'Unlucky 7: when you get it, throw away your other number and modifier cards. It can\'t bust you, and it\'s worth 7.',
                'Lucky 13: you may hold one other 13. Both score and both count toward the seven. A third 13 busts.',
                'These effects only last while the card is in your hand.',
            ],
        },
        {
            title: 'Modifiers and actions',
            items: [
                '−2, −4, −6, −8, −10: played on any player still in the round, and taken off their score.',
                '÷2: played on any player still in the round, and halves their number cards.',
                'Just One More!: the target has to take one more card, and then has to stay. It also works on a player who already stayed, who takes the card and stays out of the round.',
                'Swap: trade two face-up cards, one of yours with another player\'s, or between two other players.',
                'Steal: take any face-up card on the table into your line.',
                'Discard: choose a player and which of their cards they discard.',
                'Flip Four!: the target takes the next four cards.',
            ],
        },
        {
            title: 'Edge cases the publisher has answered',
            items: [
                'No suitable target: a Swap, Steal or Discard with no cards to act on is discarded.',
                'An Action card with a valid card to act on must be used. If you give a Steal to someone and the only other card on the table is a 13 they already hold, they have to take it and bust.',
                'Last player who hasn\'t busted? Action cards go on you, and you keep any Modifier card. Stayed players still count as targets, so this only applies when everyone else has busted.',
                'A Swap can bust a player, or two. If two players each hold a 10 and an 11, swapping one\'s 10 for the other\'s 11 busts both.',
                'A player who stayed and is hit by an Action card resolves it but doesn\'t re-enter the round.',
                'Just One More! on a player who stayed: they must take the next card and can bust on it. If it is an Action card they resolve it, and either way they remain stayed.',
                'Flip Four! stops at once on a Flip 7 or a bust. Every card flipped counts toward the four.',
                'Action and Modifier cards revealed during a Flip Four! wait, then resolve in order after the four, but only if the player didn\'t bust. They can\'t be used to save you mid-flip.',
                'Playing a waiting Just One More! on yourself: flip one card and resolve it if needed. Even if that busts you, the rest of the waiting Action cards still resolve.',
                'A player who stayed and survives a Flip Four! stays out of the round, and their revealed Action cards still resolve.',
                'Unlucky 7 when you hold a plain 7: Unlucky 7 wins, so you discard everything else, the plain 7 included. A 7 after that busts you.',
                'Unlucky 7 during a Flip Four!: discard your earlier cards, then finish the remaining flips.',
                'The Zero and Just One More!: being forced to stay can end your chance at a Flip 7, leaving you on 0.',
                'Special Number cards affect you when you get them and stop when they leave your hand. So stealing someone\'s Zero frees them and lands it on you.',
                'Modifier cards can be swapped or discarded, and don\'t count toward the seven or a bust.',
                'Deck ran out mid-round? Shuffle only the discards into a new deck. Cards in front of players stay put, even a busted player\'s.',
            ],
        },
        {
            title: 'Edge cases with no official answer',
            note: TABLE_RULINGS_NOTE,
            items: [
                'A Swap needs cards in front of two different players, as trading with yourself changes nothing. Otherwise discard it.',
                'A Steal with only your own cards on the table has nothing to take, so discard it.',
                'A Discard with only your own cards on the table must be used, so one of yours goes.',
                'The rulebook says Modifier cards can be swapped or discarded and leaves out stolen, so Steal takes Number cards. With no Number card to take, discard it.',
                'The "no cards to target" rule is worded for the start of a round, but it applies just the same later on.',
                'A Modifier card can be played on a player with no cards yet. It waits there, and takes effect if they get number cards.',
                'A player who stayed loses their sideways card: turn another one sideways. They stay out of the round, and with no cards left they score 0.',
                'An active player who loses every card just carries on hitting.',
                'Holding The Zero, the only ways to stop are a bust, a Flip 7, Just One More!, or losing The Zero.',
                'Stealing or being swapped an Unlucky 7 counts as getting it: you discard your other number and modifier cards, and it can\'t bust you even if you hold a plain 7.',
                'Holding an Unlucky 7, a plain 7 from a Steal or Swap busts you, as a flipped one would.',
                'Lose Lucky 13 while holding another 13: you keep the plain 13 with no bust. Getting a Lucky 13 while holding a 13 is fine too.',
                'A Flip 7 reached through a Steal, Swap or a forced flip counts, even for a player who stayed, and ends the round at once. Anything still waiting is discarded.',
                'Unlucky 7 during a Flip Four!: "earlier cards" means your line plus any Modifier cards waiting to resolve. Action cards still waiting resolve as normal.',
                'Deck and discards both empty (very rare): no one can hit, so everyone still active stays and the round ends.',
            ],
        },
        {
            title: 'How this app rules on the open cases',
            items: [
                'The Zero plus a Flip 7 scores normally: the sum, the modifiers, then 15.',
                'The Zero without a Flip 7 is 0, whatever modifiers you hold.',
                'An Unlucky 7 and a plain 7 in the final hand is a bust, because the plain 7 must have come after it.',
                'Cards next to an Unlucky 7 all score, as they came after it. The app never throws anything away for you.',
                'Two plain 13s without Lucky 13 is a bust, and so is Lucky 13 with two plain 13s.',
                'A duplicate scores as a bust by default, as the publisher\'s FAQ says for a Steal or Swap. The "Came from a Steal or Swap" switch is a house rule for tables that prefer otherwise: both cards score, but only one counts toward the seven.',
                'More than seven number cards can\'t happen in play, so you get no bonus and a reminder to check your cards.',
                'A tie at the end goes to the player earlier in the turn order. The publisher\'s FAQ for Classic says to keep playing rounds until there is one winner.',
                'Two decks aren\'t supported by the special card buttons, which allow one of each. The type dropdown still works.',
            ],
        },
    ],
    sourceUrl: VENGEANCE_RULEBOOK_URL,
    faqUrl: VENGEANCE_FAQ_URL,
};

// Only what differs from Vengeance: the sheet has that tab right beside this one.
const BRUTAL_RULES = {
    goal: VENGEANCE_RULES.goal,
    sections: [
        {
            title: 'What\'s changed from Vengeance',
            note: 'The big idea: busting no longer gets you out of danger, and a round can cost you points.',
            baseLabel: 'Vengeance',
            comparisons: [
                {
                    topic: 'Round score',
                    base: 'Minus cards stop at 0, so a round never costs you points.',
                    mode: 'Minus cards keep going, so your round score can go below 0.',
                },
                {
                    topic: 'Modifier cards',
                    base: 'Only on players who haven\'t busted.',
                    mode: 'On any player, even one who has busted.',
                },
                {
                    topic: 'After a bust',
                    base: 'You score 0 and nothing more can happen to you.',
                    mode: 'You can keep losing points, as minus cards still reach you.',
                },
                {
                    topic: 'A Flip 7',
                    base: 'Always +15 for you.',
                    mode: 'You choose: +15 for yourself, or −15 for another player.',
                },
            ],
            items: [
                'Still the same: the cards, the turn, the scoring order and everything else in Vengeance.',
            ],
        },
        {
            title: 'How this app rules on the open cases',
            items: [
                'The Zero without a Flip 7 is still 0, whatever minus cards you hold.',
                'A busted score is minus the total of your minus cards. ÷2 and The Zero do nothing to it.',
                'Minus cards from before your bust count too, as the app can\'t tell them apart.',
                'Tap Bust and add any minus cards you hold, then add each later one as it arrives, until the round closes.',
                'A −15 can hit a busted player, or one who has already scored. It goes away if the attacker changes their score or leaves, and it is ignored once its target has left.',
            ],
        },
        {
            title: 'Edge cases with no official answer',
            note: TABLE_RULINGS_NOTE,
            items: [
                'Only Modifier cards reach a busted player. Steal, Swap and Discard still can\'t, because Brutal only changes who can be given a Modifier card.',
                'So a minus card added after a bust stays where it is and keeps counting, even though it\'s face up. The rest of a busted player\'s cards are face down and out of play.',
                'If cards like these are all that\'s left on the table, a Steal, Swap or Discard has no valid card to act on and is discarded.',
                'Everyone else busted? You don\'t have to keep a Modifier card, as a busted player is now a valid target.',
                'A busted player can still be given a Modifier card by others, but flips nothing and can\'t re-enter the round.',
                'A Flip 7 with no other player to attack just takes the +15.',
                'A Flip 7 ends the round at once, so a Modifier card still waiting is discarded and hits nobody.',
            ],
        },
    ],
    sourceUrl: VENGEANCE_RULEBOOK_URL,
    faqUrl: VENGEANCE_FAQ_URL,
};

// --- The registry ------------------------------------------------------------

const TITLE_GRADIENT_TEXT = 'bg-clip-text text-transparent';
// Vengeance and Brutal share a title, so they share its look. Brutal's tag is what tells them apart.
const VENGEANCE_TITLE_CLASS = `bg-gradient-to-r from-red-300 to-rose-500 ${TITLE_GRADIENT_TEXT} [filter:drop-shadow(0_0_6px_rgba(244,63,94,0.5))]`;

/**
 * Every game mode, in the order the picker shows them: what it allows, from modeCapabilities in the
 * rule kernel, and these.
 *
 * - edition: which official game the mode is for, in words (the picker and the rules sheet, X71)
 * - bustWarning: what the Bust step says will happen, in a mode with modifiersAfterBust, else null, as
 *   the Bust tile then busts without asking
 * - entryReminder: one line shown on the score entry screens, or null
 * - submittedReminder: one line shown once a score is in, or null
 * - startLabel: the Start button's text
 * - wordmark: the room's logo (X72). `title` is the line under FLIP and the card, `titleClass` its look
 *   (its spacing is fitted to the logo's width by src/lib/logoFit.js), and `tag` a bar under it, if any
 * - mood: the screen-wide transition into this mode (see ModeShift). Colours on a timed circle
 */
export const GAME_MODES = [
    {
        ...modeCapabilities('classic'),
        label: 'Classic',
        tagline: 'The original game',
        edition: 'For Flip 7',
        highlights: [
            '×2 and +N cards',
            'Freeze, Flip Three and Second Chance',
            'A duplicate number busts',
            'Flip 7 scores +15',
        ],
        bustWarning: null,
        rulesContent: CLASSIC_RULES,
        entryReminder: null,
        submittedReminder: null,
        startLabel: 'Start Game',
        wordmark: {
            title: 'Classic',
            titleClass: `bg-gradient-to-r from-amber-200 to-yellow-400 ${TITLE_GRADIENT_TEXT} [filter:drop-shadow(0_0_6px_rgba(250,204,21,0.45))]`,
        },
        mood: {
            background: 'radial-gradient(circle at var(--mode-shift-origin), #818cf8 0%, #3730a3 45%, #0f172a 100%)',
            coverMs: 400,
            fadeMs: 400,
        },
    },
    {
        ...modeCapabilities('vengeance'),
        label: 'Vengeance',
        tagline: 'Your cards are never safe',
        edition: 'For Flip 7: With a Vengeance',
        highlights: [
            '−N and ÷2 cards',
            'The Zero, Unlucky 7 and Lucky 13',
            'Steal, Swap and Discard',
            'Round score can\'t go below 0',
        ],
        bustWarning: null,
        rulesContent: VENGEANCE_RULES,
        entryReminder: 'Score once the round ends, cards aren\'t safe until then.',
        submittedReminder: 'If your cards change before the round ends, change your score.',
        startLabel: 'Start Vengeance Game',
        wordmark: {
            title: 'Vengeance',
            titleClass: VENGEANCE_TITLE_CLASS,
        },
        mood: {
            background: 'radial-gradient(circle at var(--mode-shift-origin), #f87171 0%, #6f1030 45%, #2a1033 100%)',
            coverMs: 400,
            fadeMs: 400,
        },
    },
    {
        ...modeCapabilities('brutal'),
        label: 'Brutal',
        tagline: 'Vengeance with no mercy',
        edition: 'House rules for Flip 7: With a Vengeance',
        highlights: [
            'Vengeance cards',
            'Round score can go below 0',
            'Modifiers can hit busted players',
            'Flip 7: +15 for you or −15 for a rival',
        ],
        bustWarning: 'Your cards score nothing, but any minus cards you get still count against you.',
        rulesContent: BRUTAL_RULES,
        entryReminder: 'Score once the round ends, cards aren\'t safe until then.',
        submittedReminder: 'If your cards change before the round ends, change your score.',
        startLabel: 'Start Brutal Game',
        wordmark: {
            title: 'Vengeance',
            titleClass: VENGEANCE_TITLE_CLASS,
            tag: 'Brutal',
        },
        mood: {
            background: 'radial-gradient(circle at var(--mode-shift-origin), #f87171 0%, #7f1d1d 30%, #0a0404 100%)',
            coverMs: 280,
            fadeMs: 320,
        },
    },
];

/**
 * The registry entry for `mode`. Stored rooms have no migration, so missing or unknown reads as
 * classic.
 *
 * @param {string|null|undefined} mode
 */
export function getRules(mode) {
    const entry = GAME_MODES.find((candidate) => candidate.id === mode);
    if (entry) {
        return entry;
    }
    return GAME_MODES.find((candidate) => candidate.id === DEFAULT_GAME_MODE);
}

// --- Changing mode -----------------------------------------------------------

/**
 * Whether the host may still change the room's mode. It locks at the first score, because every
 * score in a room was scored under its current mode (§3.2). The server has the final say.
 *
 * @param {{status: string}} room
 * @param {object[]} roundScores  all of the room's RoundScores
 */
export function canChangeMode(room, roundScores) {
    if (room.status === 'waiting') {
        return true;
    }
    return room.status === 'playing' && roundScores.length === 0;
}

/**
 * How a mode change plays: 'circle', or 'cross-fade' for everyone. A full-screen clip-path can stutter
 * on a weak GPU, and it hasn't been tried on a real mid-range phone. If it stutters, change this line.
 */
export const MODE_SHIFT_STYLE = 'circle';

/** Reduced motion always gets the plain cross-fade. */
export function usesCrossFade({ prefersReducedMotion, style = MODE_SHIFT_STYLE }) {
    return prefersReducedMotion || style === 'cross-fade';
}

/**
 * The change to announce between two values of a room's mode, or null. Only a real change between
 * two known modes counts, so first load, refetch, rejoin and reopening a game stay silent.
 *
 * @returns {{from: string, to: string}|null}
 */
export function modeTransition(previous, next) {
    if (previous === next || !isKnownGameMode(previous) || !isKnownGameMode(next)) {
        return null;
    }
    return { from: previous, to: next };
}

/**
 * The words that go with a mode change, as the animation is easy to miss when looking at the
 * table. The host made the change, so they only need telling about their own open cards.
 *
 * @param {{isHost: boolean, label: string, hasEntryOpen: boolean}} change
 * @returns {string|null}
 */
export function modeChangeMessage({ isHost, label, hasEntryOpen }) {
    const parts = [];
    if (!isHost) {
        parts.push(`Host switched to ${label}`);
    }
    if (hasEntryOpen) {
        parts.push('Your cards were re-scored');
    }

    if (parts.length === 0) {
        return null;
    }
    return parts.join('. ');
}

// --- The mode this device last chose -----------------------------------------

/** @param {Storage|null} [storage]  injectable for tests; null when storage is blocked */
export function readLastGameMode(storage = getLocalStorage()) {
    if (!storage) {
        return DEFAULT_GAME_MODE;
    }
    return getRules(readJson(storage, LAST_GAME_MODE_KEY, DEFAULT_GAME_MODE)).id;
}

/**
 * @param {string} mode
 * @param {Storage|null} [storage]  injectable for tests; null when storage is blocked
 */
export function rememberGameMode(mode, storage = getLocalStorage()) {
    if (storage) {
        writeJson(storage, LAST_GAME_MODE_KEY, mode);
    }
}
