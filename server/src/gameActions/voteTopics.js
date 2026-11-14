import { createRoomActionRunner } from '../actions/createGameActions.js';
import { MakeHostAction } from '../actions/players/MakeHostAction.js';
import { createVoteTopics as createTopicsForRunner } from '../actions/VoteTopics.js';
import { PlayerService } from '../services/PlayerService.js';
import { RoundService } from '../services/RoundService.js';
import { TotalsService } from '../services/TotalsService.js';

// Test-facing adapter (see roomTx.js): the old createVoteTopics(context), over
// actions/VoteTopics.js, for coverageGaps.test.

/**
 * `context` is the app context ({ store, hub, config, logger }). The runner is built when a vote
 * resolves, as the old code did, so topics built from a context without a store can still check
 * options. MakeHostAction only needs PlayerService, which reads no repository.
 */
export function createVoteTopics(context) {
    const runner = {
        runAsSystem(handler, roomId, body) {
            return createRoomActionRunner(context).runAsSystem(handler, roomId, body);
        },
    };
    const playerService = new PlayerService({ roundService: new RoundService(), totalsService: new TotalsService() });
    const makeHostAction = new MakeHostAction({ playerService });
    return createTopicsForRunner({ runner, makeHostAction });
}
