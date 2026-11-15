import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createActionRegistry, createServices } from '../../src/actions/createGameActions.js';
import { ACTIONS } from '../../src/gameActions/index.js';
import { runRoomAction, storeOfWork } from '../../src/gameActions/roomTx.js';
import { createRoom, lookupRoomByCode } from '../../src/gameActions/rooms.js';
import { createVoteTopics } from '../../src/gameActions/voteTopics.js';
import { createUnitOfWork, GUEST, HOST, OUTSIDER, openTempStore, seedRoom } from './roomFixture.js';

// The test-facing adapters in gameActions/ that the other tests and the root test fixture
// (tests/fixtures/serverRoom.js) import: each must run the real handler on the real store. The
// unit of work and runRoomAction adapters are exercised by coverageGaps.test and rooms.test; the
// action objects and createRoom run here inside runRoomAction, as the root test fixture runs them.

const ACTION_NAMES = [
    'set-game-mode', 'start', 'close', 'delete',
    'join', 'leave', 'kick', 'make-host', 'reorder',
    'submit-score', 'retract-score', 'force-next-round', 'set-edit-mode', 'edit-score', 'end-game',
    'reopen-game', 'play-again', 'set-games-won',
];

/** A hub that ignores everything, for running actions without the realtime server. */
const SILENT_HUB = {
    publishAll() {},
    roomMembershipChanged() {},
    roomHostChanged() {},
};

describe('gameActions adapters', () => {
    let temp;
    let store;
    let seeded;

    beforeEach(() => {
        temp = openTempStore();
        store = temp.store;
        seeded = seedRoom(store);
    });

    afterEach(() => {
        temp.close();
    });

    function adapterContext() {
        return { store, hub: SILENT_HUB, config: { adminEmails: new Set() }, logger: console };
    }

    /**
     * Runs `act(work)` through runRoomAction as `user`, on the seeded room unless `roomId` says
     * otherwise (null for none), with no access or status check. Returns { work, returned }:
     * the unit of work after commit and what `act` returned.
     */
    function runInWork(user, act, { roomId = seeded.room.id } = {}) {
        let work = null;
        let returned;
        const request = { user, roomId, access: 'signed_in', allowedStatuses: null };
        const result = runRoomAction(adapterContext(), request, (tx) => {
            work = tx;
            returned = act(tx);
            return returned;
        });

        assert.equal(result.status, 200);
        return { work, returned };
    }

    // --- ACTIONS ---------------------------------------------------------

    test('ACTIONS has every game action, each with its handler\'s access and statuses', () => {
        const registry = createActionRegistry(createServices(store.repositories));

        assert.deepEqual(Object.keys(ACTIONS).sort(), [...ACTION_NAMES].sort());
        for (const name of ACTION_NAMES) {
            const handler = registry.get(name);
            assert.equal(ACTIONS[name].access, handler.access, name);
            assert.deepEqual(ACTIONS[name].allowedStatuses, handler.allowedStatuses, name);
        }
    });

    test('an action object runs its own handler and returns what it returns', () => {
        const { returned: joined } = runInWork(OUTSIDER, (work) => ACTIONS.join.run(work, { name: 'Otto' }));

        assert.equal(joined.already_joined, false);
        assert.equal(joined.player.email, OUTSIDER.email);
        assert.equal(joined.player.name, 'Otto');
    });

    test('room, player and scoring action objects all reach their services', () => {
        const { work } = runInWork(HOST, (tx) => {
            ACTIONS['set-game-mode'].run(tx, { game_mode: 'vengeance' });
            ACTIONS['make-host'].run(tx, { player_id: seeded.guest.id });
            ACTIONS.start.run(tx, {});
            ACTIONS['end-game'].run(tx, {});
            ACTIONS['play-again'].run(tx, {});
        });

        assert.equal(work.room.game_mode, 'vengeance');
        assert.equal(work.room.host_player_id, seeded.guest.id);
        assert.equal(work.room.status, 'waiting');
        assert.equal(work.room.game_number, 2);
    });

    // --- Rooms -----------------------------------------------------------

    test('createRoom parses the body and creates the room', () => {
        const { work, returned } = runInWork(GUEST, (tx) => createRoom(tx, { max_score: 120, name: 'Gus' }), { roomId: null });
        const { player } = returned;

        assert.equal(work.room.max_score, 120);
        assert.equal(work.room.game_mode, 'classic');
        assert.equal(work.room.host_player_id, player.id);
        assert.equal(player.name, 'Gus');
    });

    test('lookupRoomByCode answers 200 with the room, or 404 with the error body', () => {
        const found = lookupRoomByCode(store, GUEST, 'abcdef');
        assert.equal(found.status, 200);
        assert.equal(found.body.room.id, seeded.room.id);
        assert.equal(found.body.my_player.id, seeded.guest.id);

        assert.deepEqual(lookupRoomByCode(store, GUEST, 'NOPE22'), {
            status: 404,
            body: { message: 'Room not found', code: 'room_not_found' },
        });
    });

    test('the action objects and createRoom refuse a unit of work runRoomAction is not running', () => {
        const work = createUnitOfWork(store, HOST);
        work.loadRoom(seeded.room.id);

        assert.equal(storeOfWork(runInWork(HOST, () => {}).work), store);
        assert.throws(() => ACTIONS.start.run(work, {}), /needs a unit of work from runRoomAction/);
        assert.throws(() => createRoom(work, { max_score: 120 }), /needs a unit of work from runRoomAction/);
    });

    // --- Vote topics -----------------------------------------------------

    test('createVoteTopics resolves make-host through a runner on the context', () => {
        const topic = createVoteTopics(adapterContext())['make-host'];

        const result = topic.resolve(seeded.room.id, seeded.guest.id);

        assert.equal(result.status, 200);
        assert.equal(result.body.room.host_player_id, seeded.guest.id);
        assert.equal(store.getRecord('GameRoom', seeded.room.id).host_email, GUEST.email);
    });
});
