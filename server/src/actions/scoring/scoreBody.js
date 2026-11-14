import { MAX_CARDS_PER_ROUND } from '../../../../shared/rules.js';
import { badRequest } from '../../domain/errors.js';
import { isPlainObject } from '../../lib/query.js';

// Request body parsing shared by the scoring action handlers. Each require* returns the field's
// value, checked against docs/backend-contract.md, or throws a 400 bad_request.

// Scores can be negative (X1: a negative number card), so they range over ±1000.
const MIN_SCORE_VALUE = -1000;
const MAX_SCORE_VALUE = 1000;

// --- Plain fields --------------------------------------------------------

export function requireBoolean(body, field) {
    const value = body[field];
    if (typeof value !== 'boolean') {
        throw badRequest(`${field} must be a boolean`);
    }
    return value;
}

/** A boolean that may be left out, which means false. */
function readOptionalBoolean(body, field) {
    if (body[field] === undefined) {
        return false;
    }
    return requireBoolean(body, field);
}

export function requireRoundNumber(body) {
    const roundNumber = body.round_number;
    if (!Number.isInteger(roundNumber) || roundNumber < 1) {
        throw badRequest('round_number must be a positive integer');
    }
    return roundNumber;
}

/** { player_id: wins } with every wins an integer >= 0. */
export function requireWins(body) {
    const wins = body.wins;
    if (!isPlainObject(wins)) {
        throw badRequest('wins must be an object of player_id to integer');
    }
    for (const value of Object.values(wins)) {
        if (!Number.isInteger(value) || value < 0) {
            throw badRequest('each wins value must be an integer of 0 or more');
        }
    }
    return wins;
}

// --- Scores --------------------------------------------------------------

/** A player id that may be left out or null, which both mean no attack. */
function readAttackPlayerId(body) {
    const playerId = body.flip7_attack_player_id;
    if (playerId === undefined || playerId === null) {
        return null;
    }
    if (typeof playerId !== 'string' || playerId === '') {
        throw badRequest('flip7_attack_player_id must be a non-empty string or null');
    }
    return playerId;
}

function isScoreValue(value) {
    return Number.isInteger(value) && value >= MIN_SCORE_VALUE && value <= MAX_SCORE_VALUE;
}

function isCard(card) {
    return isPlainObject(card) && typeof card.value === 'string' && typeof card.type === 'string';
}

/**
 * The score fields of a submit or edit body, checked against the contract: at most 30
 * `{value, type}` cards (other card fields are dropped), base_sum and final_score integers from
 * -1000 to 1000, and the optional flags busted and duplicate_allowed and target
 * flip7_attack_player_id. These are always stored, so a replacing score that leaves one out doesn't
 * keep the old value. The target is only checked once the score is to be applied, by
 * ScoringService.
 */
export function requireScore(body) {
    const cards = body.cards;
    const hasValidCards = Array.isArray(cards) && cards.length <= MAX_CARDS_PER_ROUND && cards.every(isCard);
    if (!hasValidCards) {
        throw badRequest(`cards must be an array of at most ${MAX_CARDS_PER_ROUND} {value, type} strings`);
    }
    if (!isScoreValue(body.base_sum) || !isScoreValue(body.final_score)) {
        throw badRequest(`base_sum and final_score must be integers from ${MIN_SCORE_VALUE} to ${MAX_SCORE_VALUE}`);
    }

    return {
        cards: cards.map((card) => ({ value: card.value, type: card.type })),
        base_sum: body.base_sum,
        final_score: body.final_score,
        busted: readOptionalBoolean(body, 'busted'),
        duplicate_allowed: readOptionalBoolean(body, 'duplicate_allowed'),
        flip7_attack_player_id: readAttackPlayerId(body),
    };
}
