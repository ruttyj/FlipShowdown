import { RoundService } from '../services/RoundService.js';

// The old function API over RoundService: runRoundCheck for players.js until P3.3 moves it to
// PlayerService, and advanceRound for coverageGaps.test. `tx` is the action's RoomUnitOfWork.
// RoundService is built per call rather than once here: RoundService.js imports players.js, which
// imports this file, so when RoundService.js is loaded first the class isn't defined yet while this
// file runs. It is stateless, so a new one per call behaves the same.

/** See RoundService#advanceRound. */
export function advanceRound(tx) {
    new RoundService().advanceRound(tx);
}

/**
 * See RoundService#runRoundCheck. Callers still pass tx.room as a second argument, which is
 * ignored: every caller passed the action's room, and RoundService reads it from `tx`.
 */
export function runRoundCheck(tx) {
    new RoundService().runRoundCheck(tx);
}
