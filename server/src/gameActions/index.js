import { createActionRegistry, createGameHandlers, createServices } from '../actions/createGameActions.js';

// Test-facing adapter (see roomTx.js): every game action as the old
// `{ access, allowedStatuses, run(tx, body) }` object, by name, for the root test fixture
// (tests/fixtures/serverRoom.js). Each runs the same handler class the rooms router runs.

/**
 * The old action object for `declaration`, a handler read only for its name, access and statuses.
 * Handlers hold their services, and RoomService needs the store's repositories, so `run` builds
 * them on the store that `tx` (a RoomUnitOfWork) writes to. Services are stateless, so building
 * them per call behaves as building them once.
 */
function toActionObject(declaration) {
    return {
        access: declaration.access,
        allowedStatuses: declaration.allowedStatuses,
        run(tx, body) {
            const registry = createActionRegistry(createServices(tx.store.repositories));
            return registry.get(declaration.name).handle(tx, body);
        },
    };
}

function createActionObjects() {
    const actions = {};
    // Built without services: these are only read, never run.
    for (const declaration of createGameHandlers({})) {
        actions[declaration.name] = toActionObject(declaration);
    }
    return actions;
}

export const ACTIONS = createActionObjects();
