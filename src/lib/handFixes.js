// Help for a hand that looks wrong. A plain 13 read in place of Lucky 13 would wrongly bust someone,
// which is the worst failure in the Vengeance deck, so a bust on 13s or 7s offers a one-tap fix.

import { calculateFlip7Score } from './flip7Scoring.js';
import { getRules } from './gameRules.js';

const UNLUCKY_SEVEN = '7';

// mustEndBust: Lucky 13 is only worth offering if it rescues the hand. The Unlucky 7 one corrects the
// reading even though the hand stays bust (X42), and a line then says why.
const FIXES = [
    {
        value: '13',
        label: 'Change one 13 to Lucky 13',
        announcement: 'Changed one 13 to Lucky 13.',
        mustEndBust: true,
    },
    {
        value: UNLUCKY_SEVEN,
        label: 'Change one 7 to Unlucky 7',
        announcement: 'Changed one 7 to Unlucky 7.',
        mustEndBust: false,
    },
];

function isPlainNumber(card, value) {
    return card.type === 'number' && parseInt(card.value, 10) === Number(value);
}

function isSpecial(card, value) {
    return card.type === 'special' && card.value === value;
}

function countPlainNumbers(cards, value) {
    return cards.filter((card) => isPlainNumber(card, value)).length;
}

/**
 * The hand with its first plain card of that number turned into the special card.
 *
 * @param {{type: string, value: string}[]} cards
 * @param {string} value  the fix's value
 */
export function applyMisreadFix(cards, value) {
    const index = cards.findIndex((card) => isPlainNumber(card, value));
    const fixed = [...cards];
    fixed[index] = { type: 'special', value };
    return fixed;
}

function canApplyFix(cards, fix, mode) {
    const isInMode = getRules(mode).specialCards.includes(fix.value);
    const isHeld = cards.some((card) => isSpecial(card, fix.value));
    if (!isInMode || isHeld || countPlainNumbers(cards, fix.value) < 2) {
        return false;
    }

    if (!fix.mustEndBust) {
        return true;
    }
    const fixedHand = applyMisreadFix(cards, fix.value);
    return !calculateFlip7Score(fixedHand, mode).isDuplicateBust;
}

/**
 * The fixes to offer for a busted hand. Only for repeated plain cards of a number that has a special
 * card in this mode, while that special isn't already in the hand.
 *
 * @param {{type: string, value: string}[]} cards
 * @param {{isDuplicateBust: boolean}} score  the hand's score
 * @param {string} mode
 * @returns {{value: string, label: string, announcement: string, mustEndBust: boolean}[]}
 */
export function misreadFixes(cards, score, mode) {
    if (!score.isDuplicateBust) {
        return [];
    }
    return FIXES.filter((fix) => canApplyFix(cards, fix, mode));
}

// --- The Steal or Swap override --------------------------------------------

/**
 * Whether to offer "Came from a Steal or Swap": a hand the mode would bust on a duplicate, in a mode
 * with those cards. The hand can't show whether a duplicate was flipped, so the player vouches for it.
 *
 * @param {{type: string, value: string}[]} cards
 * @param {string} mode
 */
export function canOverrideDuplicate(cards, mode) {
    if (!getRules(mode).offersDuplicateOverride) {
        return false;
    }
    return calculateFlip7Score(cards, mode).isDuplicateBust;
}

/**
 * The hand's score with the entry screen's choices applied, plus what counted:
 * - `duplicateAllowed`: the override. A switch left on after its duplicate has gone doesn't count, so
 *   it is never stored on a score it had no part in.
 * - `offersFlip7Attack`: the hand can choose between +15 and -15 for a rival (X43), which only a
 *   hand with a bonus to give up can.
 * - `flip7AttackPlayerId`: the rival, or null. Like the override, it is dropped when the hand or the
 *   mode can't attack, so the choice can stay on screen while the player fixes their cards.
 *
 * @param {{type: string, value: string}[]} cards
 * @param {string} mode
 * @param {{busted?: boolean, overrideOn?: boolean, attackPlayerId?: string|null}} [choices]
 * @returns {import('./handScoring.js').HandScore & {duplicateAllowed: boolean, offersFlip7Attack: boolean, flip7AttackPlayerId: string|null}}
 */
export function scoreHand(cards, mode, { busted = false, overrideOn = false, attackPlayerId = null } = {}) {
    const duplicateAllowed = !busted && overrideOn && canOverrideDuplicate(cards, mode);
    const options = { busted, duplicateAllowed };
    const score = calculateFlip7Score(cards, mode, options);
    const offersFlip7Attack = getRules(mode).hasFlip7Attack && score.bonus > 0;

    if (!offersFlip7Attack || attackPlayerId === null) {
        return { ...score, duplicateAllowed, offersFlip7Attack, flip7AttackPlayerId: null };
    }

    const attackScore = calculateFlip7Score(cards, mode, { ...options, flip7Attack: true });
    return { ...attackScore, duplicateAllowed, offersFlip7Attack, flip7AttackPlayerId: attackPlayerId };
}

/**
 * The chosen rival if they are still in the room, else null. A score naming someone who has left would
 * be refused, and there is nobody to take the 15 from.
 *
 * @param {string|null|undefined} chosenId
 * @param {{id: string}[]} targets  the other players
 * @returns {string|null}
 */
export function liveAttackTarget(chosenId, targets) {
    const isStillHere = targets.some((target) => target.id === chosenId);
    return isStillHere ? chosenId : null;
}

// --- Reminder ----------------------------------------------------------------

/**
 * A quiet line about Unlucky 7, or null. The app scores the final hand and never discards anything
 * itself, so the player has to have done it. A plain 7 next to it is a bust no fix can undo (§2).
 *
 * @param {{type: string, value: string}[]} cards
 * @param {string} mode
 * @returns {string|null}
 */
export function handReminder(cards, mode) {
    const hasUnluckyInMode = getRules(mode).specialCards.includes(UNLUCKY_SEVEN);
    const hasUnlucky = cards.some((card) => isSpecial(card, UNLUCKY_SEVEN));
    if (!hasUnluckyInMode || !hasUnlucky || cards.length === 1) {
        return null;
    }

    if (countPlainNumbers(cards, UNLUCKY_SEVEN) > 0) {
        return 'A 7 flipped after the Unlucky 7 is still a duplicate, so this hand busts.';
    }
    return 'Unlucky 7 discards the cards you had before it.';
}
