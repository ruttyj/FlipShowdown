import { decodeRow, ENTITY_TABLES } from '../database/entityTables.js';
import { ROUND_SCORE } from '../domain/entities.js';
import { TableRepository } from './TableRepository.js';

// The round_scores table: one row per player per round. get, insert, update and delete come from
// TableRepository; this class adds the named reads the scoring code needs.

const SELECT_FOR_PLAYER = `
    SELECT * FROM round_scores
    WHERE room_id = ? AND player_id = ?
    ORDER BY seq
`;

export class RoundScoreRepository extends TableRepository {
    constructor(database) {
        super(database, ENTITY_TABLES.get(ROUND_SCORE));
        this.selectForPlayer = database.prepare(SELECT_FOR_PLAYER);
    }

    /** The room's scores in the order they were first saved (oldest first). */
    listByRoom(roomId) {
        return this.find('room_id', roomId);
    }

    /**
     * The player's score for `roundNumber` in the room, or null. If the table somehow holds more
     * than one, the oldest wins.
     *
     * The round is matched in JS with ===, like the scoring code always has: SQL would also match
     * the string '3' to round 3 and could match a null round to a legacy value kept in `extra`.
     */
    findForRound(roomId, playerId, roundNumber) {
        const rows = this.selectForPlayer.all(roomId, playerId);
        for (const row of rows) {
            const score = decodeRow(this.spec, row);
            if (score.round_number === roundNumber) {
                return score;
            }
        }
        return null;
    }
}
