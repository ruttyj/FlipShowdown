import { TotalsService } from '../services/TotalsService.js';

// The old function API over TotalsService, for players.js until P3.3 moves it to PlayerService.
// `tx` is the action's RoomUnitOfWork.

/** See TotalsService#recomputeAttackTarget. */
export function recomputeAttackTarget(tx, targetId) {
    new TotalsService().recomputeAttackTarget(tx, targetId);
}
