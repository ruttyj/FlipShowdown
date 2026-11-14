import { badRequest } from '../domain/errors.js';

// Body parsing shared by the actions that name a player (kick, make-host and edit-score).

/** The body's player_id, or a 400 `bad_request` when it isn't a non-empty string. */
export function requirePlayerId(body) {
    const playerId = body.player_id;
    if (typeof playerId !== 'string' || playerId === '') {
        throw badRequest('player_id must be a non-empty string');
    }
    return playerId;
}
