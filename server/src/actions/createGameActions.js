import { PlayerService } from '../services/PlayerService.js';
import { RoomService } from '../services/RoomService.js';
import { RoundService } from '../services/RoundService.js';
import { ScoringService } from '../services/ScoringService.js';
import { TotalsService } from '../services/TotalsService.js';
import { AccessPolicy } from './AccessPolicy.js';
import { ActionRegistry } from './ActionRegistry.js';
import { RoomActionRunner } from './RoomActionRunner.js';
import { createPlayerActions } from './players/index.js';
import { createRoomActions } from './rooms/index.js';
import { createScoringActions } from './scoring/index.js';

// Builders for the game actions: the services, the handlers and their registry. The server builds
// them once in providers/GameProvider.js; the test-facing adapters in gameActions/ build their own.

/**
 * The game services. RoomService reads the store's `repositories`; the others are stateless and
 * take the action's RoomUnitOfWork on every call. Returns { roomService, playerService,
 * scoringService, roundService, totalsService }.
 */
export function createServices(repositories) {
    const totalsService = new TotalsService();
    const roundService = new RoundService();
    const roomService = new RoomService({
        roomRepository: repositories.rooms,
        playerRepository: repositories.players,
    });
    return {
        roomService,
        playerService: new PlayerService({ roundService, totalsService }),
        scoringService: new ScoringService({ roundService, totalsService, roomService }),
        roundService,
        totalsService,
    };
}

/** Every game action's handler, each with its action `name`, on `services` (see createServices). */
export function createGameHandlers(services) {
    return [
        ...createRoomActions(services),
        ...createPlayerActions(services),
        ...createScoringActions(services),
    ];
}

/** An ActionRegistry of every game action's handler, by name. */
export function createActionRegistry(services) {
    const registry = new ActionRegistry();
    for (const handler of createGameHandlers(services)) {
        registry.add(handler.name, handler);
    }
    return registry;
}

/**
 * A RoomActionRunner for the adapters' context ({ store, hub, config, logger }). The hub is read
 * from the context each time the runner publishes, so a test may set or replace it later.
 */
export function createRoomActionRunner(context) {
    return new RoomActionRunner({
        database: context.store.database,
        repositories: context.store.repositories,
        store: context.store,
        accessPolicy: new AccessPolicy(),
        adminEmails: context.config.adminEmails,
        getHub: () => context.hub,
        logger: context.logger,
    });
}
