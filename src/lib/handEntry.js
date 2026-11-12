// A hand entry: one player's cards while they are being entered or corrected, with the choices made
// about them. Manual entry, the scanner and the host's score editor all work on one of these, so they
// can't disagree on what counts, what it scores, whether it can be confirmed or what gets sent.
// useHandEntry (src/hooks/useHandEntry.js) holds one in React state.

import { liveAttackTarget, canOverrideDuplicate, scoreHand } from './handFixes.js';
import {
    MAX_CARDS_PER_ROUND,
    createEmptyCard,
    dropBlankCards,
    sanitizeCards,
    startingCards,
} from './scoreEntryCards.js';

/**
 * @typedef {object} HandEntry
 * @property {{type: string, value: string}[]} cards  the rows on screen, blank ones included
 * @property {boolean} overrideOn  the "Came from a Steal or Swap" switch
 * @property {string|null} chosenAttackId  the Flip 7 choice, who may have left the room since
 * @property {boolean} isBustOn  the host's Bust switch. Other screens never set it.
 */

/**
 * @typedef {object} HandEntryStart
 * @property {{type: string, value: string}[]|null} [cards]  from a draft, a stored score or nothing
 * @property {boolean} [duplicateAllowed]
 * @property {string|null} [attackPlayerId]
 * @property {boolean} [busted]
 * @property {boolean} [startsWithBlankRow]  no cards means one row to type in, rather than no rows
 */

/**
 * A new hand entry. Cards come in settled, whatever stored them (X34).
 *
 * @param {HandEntryStart} [start]
 * @param {string} [gameMode]
 * @returns {HandEntry}
 */
export function startHandEntry(start = {}, gameMode) {
    const { cards, duplicateAllowed = false, attackPlayerId = null, busted = false, startsWithBlankRow = false } = start;

    let rows = sanitizeCards(cards ?? [], gameMode);
    if (startsWithBlankRow) {
        rows = startingCards(cards, gameMode);
    }
    return { cards: rows, overrideOn: duplicateAllowed, chosenAttackId: attackPlayerId, isBustOn: busted };
}

/**
 * The entry after the Bust switch changes. Off rescores the cards still here. An empty hand has nothing
 * to rescore, so it gets a row to fill in. On keeps the cards.
 *
 * @param {HandEntry} entry
 * @param {boolean} isOn
 * @returns {HandEntry}
 */
export function changeBust(entry, isOn) {
    if (!isOn && entry.cards.length === 0) {
        return { ...entry, isBustOn: isOn, cards: [createEmptyCard()] };
    }
    return { ...entry, isBustOn: isOn };
}

/**
 * Everything a screen needs to know about an entry:
 * - `countedCards`: the rows that count, without the blank ones (X2, X19).
 * - `attackPlayerId`: the chosen rival if they are still here, else null (X43).
 * - `score`: the hand's score, as `scoreHand` gives it.
 * - `offersOverride`: whether the Steal or Swap switch applies to this hand (X45).
 * - `hasTooManyCards`: over what the server accepts in a round.
 * - `canConfirm`: there is a hand to send and the server would take it. A screen adds its own reasons
 *   to wait, such as a scan or a submit under way.
 * - `confirmedHand`: what to send. A typed 0 may still be waiting for its field's blur, as iOS doesn't
 *   focus a tapped button, so the cards are settled here. That makes it a special card but scores
 *   the same, so `score` is right for both the rows on screen and these cards.
 *
 * @param {HandEntry} entry
 * @param {object} context
 * @param {string} [context.gameMode]  read live, so a switch by the host re-scores the same cards
 * @param {{id: string}[]} [context.attackTargets]  the other players
 * @param {boolean} [context.allowsEmptyHand]  no cards can be confirmed, as a score of 0
 */
export function readHandEntry(entry, { gameMode, attackTargets = [], allowsEmptyHand = false }) {
    const { cards, overrideOn, chosenAttackId, isBustOn } = entry;

    const countedCards = dropBlankCards(cards);
    const attackPlayerId = liveAttackTarget(chosenAttackId, attackTargets);
    const score = scoreHand(countedCards, gameMode, { busted: isBustOn, overrideOn, attackPlayerId });
    const hasHand = countedCards.length > 0 || allowsEmptyHand;
    const hasTooManyCards = countedCards.length > MAX_CARDS_PER_ROUND;

    return {
        countedCards,
        attackPlayerId,
        score,
        offersOverride: !isBustOn && canOverrideDuplicate(countedCards, gameMode),
        hasTooManyCards,
        canConfirm: hasHand && !hasTooManyCards,
        confirmedHand: { cards: sanitizeCards(countedCards, gameMode), ...score },
    };
}
