import { JoinAction } from './JoinAction.js';
import { KickAction } from './KickAction.js';
import { LeaveAction } from './LeaveAction.js';
import { MakeHostAction } from './MakeHostAction.js';
import { ReorderAction } from './ReorderAction.js';

/**
 * The player action handlers, to register in an ActionRegistry under their `name`. `services`
 * holds at least `playerService`, a PlayerService.
 */
export function createPlayerActions(services) {
    return [
        new JoinAction(services),
        new LeaveAction(services),
        new KickAction(services),
        new MakeHostAction(services),
        new ReorderAction(services),
    ];
}
