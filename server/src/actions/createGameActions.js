import { PlayerService } from '../services/PlayerService.js';
import { RoomService } from '../services/RoomService.js';
import { RoundService } from '../services/RoundService.js';
import { ScoringService } from '../services/ScoringService.js';
import { TotalsService } from '../services/TotalsService.js';
import { AccessPolicy } from './AccessPolicy.js';
import { ActionRegistry } from './ActionRegistry.js';
import { RoomActionRunner } from './RoomActionRunner.js';
import { createPlayerActions } from './players/index.js';
import { CreateRoomAction, LookupByCodeAction, createRoomActions } from './rooms/index.js';
import { createScoringActions } from './scoring/index.js';

// Wiring for the game actions: the services, the handlers and the runner, built once by app.js and
// shared by the rooms router, the vote topics and the stale-room sweep.

/**
 * The game services. RoomService reads the store's `repositories`; the others are stateless and
 * take the action's RoomUnitOfWork on every call. Returns { roomService, playerService,
 * scoringService, roundService, totalsService }.
 */
export function createServices(repositories) {
    const totalsService = new TotalsService();
    const roundService = new RoundService();
    const roomService = new RoomService({ roomRepository: repositories.rooms, playerRepository: repositories.players });
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
 * A RoomActionRunner for the app context ({ store, hub, config, logger }). The hub is read from
 * the context each time the runner publishes, since the app sets it after building the context.
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

/**
 * Everything that runs game actions, for the app context ({ store, hub, config, logger }). Returns
 * { runner, registry, createRoom, lookupByCode }: a RoomActionRunner, the ActionRegistry of the
 * game actions, the CreateRoomAction for POST /api/rooms and the LookupByCodeAction for
 * GET /api/rooms/by-code/:code.
 */
export function createGameActions(context) {
    const services = createServices(context.store.repositories);
    return {
        runner: createRoomActionRunner(context),
        registry: createActionRegistry(services),
        createRoom: new CreateRoomAction(services),
        lookupByCode: new LookupByCodeAction(services),
    };
}
