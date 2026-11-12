// Parsing of the room's max score, from the Home input and from the create-after-login URL.

import { getRules } from './gameRules.js';

export const DEFAULT_MAX_SCORE = 200;
// Set on the login return URL when "Create Room" was clicked while signed out.
export const CREATE_PARAM = 'create';
export const MAX_SCORE_PARAM = 'max_score';
export const GAME_MODE_PARAM = 'game_mode';

/**
 * The integer part of what was entered ("150abc" -> 150, "1e3" -> 1, "150.7" -> 150).
 * Missing, NaN, 0 and negative values give DEFAULT_MAX_SCORE, because the server rejects them.
 *
 * @param {string|number|null|undefined} rawValue
 * @returns {number}
 */
export function parseMaxScore(rawValue) {
    const parsed = parseInt(String(rawValue ?? ''), 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
        return DEFAULT_MAX_SCORE;
    }
    return parsed;
}

/**
 * Reads a "create a room after login" request from a URL query string.
 *
 * @param {string} search  e.g. "?create=1&max_score=150"
 * @returns {{ maxScore: number, gameMode: string } | null}  null when the URL carries no create
 *          request. An unknown mode reads as classic.
 */
export function readCreateAfterLogin(search) {
    const params = new URLSearchParams(search);
    if (params.get(CREATE_PARAM) !== '1') {
        return null;
    }
    return {
        maxScore: parseMaxScore(params.get(MAX_SCORE_PARAM)),
        gameMode: getRules(params.get(GAME_MODE_PARAM)).id,
    };
}
