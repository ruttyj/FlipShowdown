import { SYSTEM_USER } from '../domain/entities.js';
import { ActionError, StoreError } from '../domain/errors.js';
import { RoomUnitOfWork } from './RoomUnitOfWork.js';

// Runs one game action: in one database transaction it loads the room, checks the caller's access
// and the room's status, runs the handler and writes the room's version bump. Only after that
// commits does it publish the action's events through the realtime hub.

export class RoomActionRunner {
    /**
     * `database` is the Database the transaction runs on and `repositories` the store's
     * repositories, both for the units of work. `store` is the store facade, which a unit of work
     * still exposes as `store` (see RoomUnitOfWork). `accessPolicy` is an AccessPolicy,
     * `adminEmails` the Set of admin emails and `logger` a console-like object.
     * `getHub()` returns the realtime hub. It is a function because the hub's vote topics need
     * this runner, so the hub can't be passed in, and the hub's methods are called on the object
     * at publish time (tests replace them).
     */
    constructor({ database, repositories, store, accessPolicy, adminEmails, getHub, logger }) {
        this.database = database;
        this.repositories = repositories;
        this.store = store;
        this.accessPolicy = accessPolicy;
        this.adminEmails = adminEmails;
        this.getHub = getHub;
        this.logger = logger;
    }

    /**
     * Runs `handler`, which is { access, allowedStatuses, handle(work, body) }:
     *   access          - 'signed_in' | 'member' | 'host' | 'system' (see AccessPolicy)
     *   allowedStatuses - statuses the action is allowed in, or null for any
     *   handle          - does the work through the RoomUnitOfWork and may return extra
     *                     response fields
     * `request` is { user, roomId, body }: the caller's users row (SYSTEM_USER for the server),
     * the room to act on, or null when the handler creates one with insertRoom (then access and
     * status aren't checked), and the value passed to handle as `body`.
     * Returns { status, body } ready to send: 200 with `{ room, players, ...extra }`, or an
     * ActionError's or StoreError's status and body, after rolling everything back. Any other
     * error is rethrown.
     */
    run(handler, { user, roomId, body }) {
        const work = this.#createUnitOfWork(user);

        let response;
        try {
            response = this.database.transaction(() => this.#runInTransaction(work, handler, roomId, body));
        } catch (error) {
            // A StoreError is a write the database refused (say, a second open room with a code).
            const isExpectedFailure = error instanceof ActionError || error instanceof StoreError;
            if (isExpectedFailure) {
                return { status: error.status, body: error.toBody() };
            }
            throw error;
        }

        this.#publish(work);
        return { status: 200, body: response };
    }

    /**
     * Runs `handler` on the room as the server itself (SYSTEM_USER), for a passed vote or the
     * stale-room sweep: the access check is skipped, but the handler's allowed statuses still
     * apply and its events publish as usual. `body` is passed to the handler. Returns what run
     * returns.
     */
    runAsSystem(handler, roomId, body) {
        const systemHandler = {
            access: 'system',
            allowedStatuses: handler.allowedStatuses,
            handle: (work, handlerBody) => handler.handle(work, handlerBody),
        };
        return this.run(systemHandler, { user: SYSTEM_USER, roomId, body });
    }

    #createUnitOfWork(user) {
        return new RoomUnitOfWork({
            repositories: this.repositories,
            store: this.store,
            user,
            isAdmin: this.adminEmails.has(user.email),
        });
    }

    /** The transaction's body: checks, the handler, the room flush, then the response body. */
    #runInTransaction(work, handler, roomId, body) {
        if (roomId !== null) {
            work.loadRoom(roomId);
            this.accessPolicy.check(work, handler.access);
            work.requireStatus(handler.allowedStatuses);
        }

        const extra = handler.handle(work, body) || {};
        work.finish();
        return { room: work.room, players: work.listPlayers(), ...extra };
    }

    // --- Publishing ------------------------------------------------------

    /**
     * Publishes a committed action's events. The action has already committed, so a failure here
     * is logged rather than turned into an error response: the client would otherwise retry an
     * action that took effect.
     */
    #publish(work) {
        try {
            this.getHub().publishAll(work.events, { roomVersion: work.roomVersion });
        } catch (error) {
            this.logger.error(`Publishing events for room ${work.room.id} failed`, error);
        }

        try {
            this.#notifyRoomChanges(work);
        } catch (error) {
            this.logger.error(`Refreshing realtime state for room ${work.room.id} failed`, error);
        }
    }

    /** Tells the hub about changes that affect subscriptions, presence or votes. */
    #notifyRoomChanges(work) {
        // Joins, leaves and kicks change who may subscribe and who counts as online. That refresh
        // also re-evaluates the votes, so it covers a host change too.
        if (work.hasMembershipChange()) {
            this.getHub().roomMembershipChanged(work.room.id);
            return;
        }
        // A vote's voter minimum depends on whether the host is online.
        if (work.hasHostChange()) {
            this.getHub().roomHostChanged(work.room.id);
        }
    }
}
