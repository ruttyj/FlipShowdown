import { RoundService } from '../services/RoundService.js';

// Test-facing adapter (see roomTx.js): RoundService#advanceRound as the old function, for
// coverageGaps.test. `tx` is the action's RoomUnitOfWork.

const roundService = new RoundService();

/** See RoundService#advanceRound. */
export function advanceRound(tx) {
    roundService.advanceRound(tx);
}
