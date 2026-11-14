import { RoundService } from '../services/RoundService.js';

// The old function API over RoundService: advanceRound for coverageGaps.test. `tx` is the action's
// RoomUnitOfWork.

const roundService = new RoundService();

/** See RoundService#advanceRound. */
export function advanceRound(tx) {
    roundService.advanceRound(tx);
}
