import { JoinAction } from '../actions/players/JoinAction.js';
import { KickAction } from '../actions/players/KickAction.js';
import { LeaveAction } from '../actions/players/LeaveAction.js';
import { MakeHostAction } from '../actions/players/MakeHostAction.js';
import { ReorderAction } from '../actions/players/ReorderAction.js';
import { PlayerService } from '../services/PlayerService.js';
import { RoundService } from '../services/RoundService.js';
import { TotalsService } from '../services/TotalsService.js';

// The player actions as the old { access, allowedStatuses, run(tx, body) } objects, for ACTIONS
// and the vote topics until P3.3 removes gameActions/.

const playerService = new PlayerService({ roundService: new RoundService(), totalsService: new TotalsService() });

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
