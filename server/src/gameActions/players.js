import { JoinAction } from '../actions/players/JoinAction.js';
import { KickAction } from '../actions/players/KickAction.js';
import { LeaveAction } from '../actions/players/LeaveAction.js';
import { MakeHostAction } from '../actions/players/MakeHostAction.js';
import { ReorderAction } from '../actions/players/ReorderAction.js';
import { PlayerService, isTurnPassed, newPlayerFields, nextPlayerAfter } from '../services/PlayerService.js';
import { runRoundCheck } from './rounds.js';
import { recomputeAttackTarget } from './totals.js';

// The player rules' original function API, as adapters over PlayerService and the handlers in
// actions/players/. The other gameActions modules, the vote topics and the root test fixture
// (through ACTIONS) still use these until P3.3 removes gameActions/.

export { isTurnPassed, newPlayerFields, nextPlayerAfter };

/**
 * A PlayerService wired to the round and totals rules, which still live in rounds.js and totals.js
 * until P3.3 injects RoundService and TotalsService. The arrow functions read those modules'
 * exports at call time: rounds.js imports this module, so at load time its exports may not be
 * ready yet.
 */
export function createPlayerService() {
    return new PlayerService({
        rounds: { runRoundCheck: (work, room) => runRoundCheck(work, room) },
        totals: { recomputeAttackTarget: (work, targetId) => recomputeAttackTarget(work, targetId) },
    });
}

const playerService = createPlayerService();

/** Turns edit mode off (see PlayerService#clearEditMode). */
export function clearEditMode(tx) {
    playerService.clearEditMode(tx);
}

// --- Actions -------------------------------------------------------------

/** A handler as the old `{ access, allowedStatuses, run(tx, body) }` action object. */
function toRunAction(handler) {
    return {
        access: handler.access,
        allowedStatuses: handler.allowedStatuses,
        run(tx, body) {
            return handler.handle(tx, body);
        },
    };
}

const services = { playerService };

export const joinAction = toRunAction(new JoinAction(services));
export const leaveAction = toRunAction(new LeaveAction(services));
export const kickAction = toRunAction(new KickAction(services));
export const makeHostAction = toRunAction(new MakeHostAction(services));
export const reorderAction = toRunAction(new ReorderAction(services));
