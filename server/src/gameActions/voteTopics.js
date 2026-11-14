import { createRoomActionRunner } from '../actions/createGameActions.js';
import { createVoteTopics as createTopics } from '../actions/VoteTopics.js';
import { makeHostAction } from './players.js';

// The old createVoteTopics(context), as an adapter over actions/VoteTopics.js for coverageGaps.test.

/**
 * `context` is the app context. The runner is built when a vote resolves, as the old code did, so
 * a context without a store or hub yet is fine for checking options.
 */
export function createVoteTopics(context) {
    const runner = {
        runAsSystem(handler, roomId, body) {
            return createRoomActionRunner(context).runAsSystem(handler, roomId, body);
        },
    };
    const makeHostHandler = {
        allowedStatuses: makeHostAction.allowedStatuses,
        handle: (work, body) => makeHostAction.run(work, body),
    };
    return createTopics({ runner, makeHostAction: makeHostHandler });
}
