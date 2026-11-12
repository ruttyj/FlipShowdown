// Flip 7 round scoring, shared by the card scanner, manual entry and the score editor.
// Each game mode has its own scorer, chosen by the rule kernel (shared/rules.js).

import { scoreHand } from '../../shared/rules.js';

// The types a card row can be set to, in the order the card editor offers them. The `special`
// type (The Zero, Unlucky 7, Lucky 13) isn't here because its row has no value to type: see
// cardTypeOptions in src/lib/scoreEntryCards.js.
export const CARD_TYPES = [
    { value: 'number', label: 'Number' },
    { value: 'multiplier', label: 'Multiply (×)' },
    { value: 'divisor', label: 'Divide (÷)' },
    { value: 'adder', label: 'Add (+)' },
    { value: 'subtractor', label: 'Subtract (−)' },
];

/**
 * Scores one player's round from their final hand ([{ type, value }]) under the room's mode.
 * A missing or unknown mode scores as classic. See HandScore in handScoring.js for the result.
 *
 * @param {{type: string, value: string}[]} cards
 * @param {string} [mode]
 * @param {import('./handScoring.js').ScoreOptions} [options]
 * @returns {import('./handScoring.js').HandScore}
 */
export function calculateFlip7Score(cards, mode = 'classic', options = {}) {
    return scoreHand(cards, mode, options);
}

/**
 * The working shown above the final score, e.g. "12 ÷ 2 − 4 + 15 =", or
 * "Total:" when only number cards count.
 */
export function describeScoreBreakdown(score) {
    if (score.zeroed) {
        return 'The Zero scores 0 without a Flip 7:';
    }

    let text = String(score.baseSum);

    if (score.multiplier > 1) {
        text += ` × ${score.multiplier}`;
    } else if (score.multiplier < 1) {
        text += ` ÷ ${1 / score.multiplier}`;
    }

    if (score.adder > 0) {
        text += ` + ${score.adder}`;
    } else if (score.adder < 0) {
        text += ` − ${-score.adder}`;
    }

    // Without this step "6 − 10 + 15 = 15" wouldn't add up.
    if (score.flooredAtZero) {
        text += ', floored at 0';
    }

    if (score.bonus > 0) {
        text += ` + ${score.bonus}`;
    }

    const hasWorking = text !== String(score.baseSum);
    if (!hasWorking) {
        return 'Total:';
    }
    return `${text} =`;
}
