import { buildRoomActionRunner } from '../actions/createGameActions.js';

// gameActions/ holds only test-facing adapters: the old function API that tests and the root test
// fixture import by path, each a thin wrapper over the classes in actions/ and services/.
// Production code must not import this folder (eslint.config.js enforces it). Here: running an
// action and the unit of work's writes, where `tx` is a RoomUnitOfWork.

// Moved to domain/; re-exported for the tests that import them from here.
export { PLAYER, ROOM, ROUND_SCORE } from '../domain/entities.js';

// --- Unit of work ------------------------------------------------------------

export function createChild(tx, entity, fields) {
    return tx.createChild(entity, fields);
}

/** Writes only the fields that differ. Returns the current record either way. */
export function updateChild(tx, entity, record, changes) {
    return tx.updateChild(entity, record, changes);
}

export function deleteChild(tx, entity, record) {
    tx.deleteChild(entity, record);
}

/** The room's players sorted by turn_order. */
export function listPlayers(tx) {
    return tx.listPlayers();
}

// --- The store a unit of work writes to --------------------------------------
// The old action API passes only `tx` (ACTIONS[name].run(tx, body), createRoom(tx, body)), but
// the handlers' services need the store's repositories, which a RoomUnitOfWork doesn't expose.
// runRoomAction records the store of each unit of work it runs, and those adapters look it up.

const storesByWork = new WeakMap();

/** The store `tx` writes to. Throws unless `tx` is a unit of work runRoomAction is running. */
export function storeOfWork(tx) {
    const store = storesByWork.get(tx);
    if (!store) {
        throw new Error('This adapter needs a unit of work from runRoomAction');
    }
    return store;
}

// --- Running an action -------------------------------------------------------

/**
 * A RoomActionRunner for the adapters' context ({ store, hub, config, logger }). The hub is read
 * from the context each time the runner publishes, so a test may set or replace it later.
 */
export function createRoomActionRunner(context) {
    return buildRoomActionRunner({
        store: context.store,
        adminEmails: context.config.adminEmails,
        getHub: () => context.hub,
        logger: context.logger,
    });
}

/**
 * Runs one game action (see RoomActionRunner#run). `request` is { user, roomId, access,
 * allowedStatuses }; `body(tx)` does the work and may return extra response fields. Returns
 * { status, body } ready to send. `context` is the app context: { store, hub, config, logger }.
 */
export function runRoomAction(context, request, body) {
    const handler = {
        access: request.access,
        allowedStatuses: request.allowedStatuses,
        handle: (tx) => {
            storesByWork.set(tx, context.store);
            return body(tx);
        },
    };
    return createRoomActionRunner(context).run(handler, { user: request.user, roomId: request.roomId });
}
