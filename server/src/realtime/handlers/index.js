import { EntryStatusHandler } from './EntryStatusHandler.js';
import { HelloHandler } from './HelloHandler.js';
import { RoomsHandler } from './RoomsHandler.js';
import { VoteHoldHandler } from './VoteHoldHandler.js';
import { VoteReleaseHandler } from './VoteReleaseHandler.js';

/**
 * The client message handlers, to register in a SocketHandlerRegistry under their `type`. ping is
 * not among them: RealtimeServer answers it itself. `parts` holds connections, subscriptions,
 * publisher, presence, votes, entries and roomStates (see each handler's constructor).
 */
export function createSocketHandlers(parts) {
    return [
        new HelloHandler(parts),
        new RoomsHandler(parts),
        new VoteHoldHandler(parts),
        new VoteReleaseHandler(parts),
        new EntryStatusHandler(parts),
    ];
}
