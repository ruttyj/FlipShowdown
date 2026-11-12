// The hint for a room left in Classic while the table plays with the Vengeance deck.

export const WRONG_DECK_HINT = 'These look like Vengeance cards. Ask the host to switch';

/**
 * The base game has no 13, ÷2 or minus card, so a room in Classic that read one is on the wrong deck. Other
 * scan modes expect those cards, so they say nothing about the deck.
 *
 * @param {string} scanMode  the room's `scanMode` now, not the one the photo was sent under. A host
 *   switching mid-scan changes the advice: a room just moved to Vengeance has nothing left to ask
 *   for, and one just moved to Classic with a 13 on the table does.
 * @param {{value: string, type: string}[]} scannedCards  as the server sent them
 * @returns {string|null}  the hint to show, if any
 */
export function wrongDeckHint(scanMode, scannedCards) {
    if (scanMode !== 'classic') {
        return null;
    }

    for (const card of scannedCards) {
        const isThirteen = card.type === 'number' && card.value === '13';
        const isVengeanceModifier = card.type === 'divisor' || card.type === 'subtractor';
        if (isThirteen || isVengeanceModifier) {
            return WRONG_DECK_HINT;
        }
    }
    return null;
}
