import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createActionRegistry, createServices } from '../../src/actions/createGameActions.js';
import { RoomUnitOfWork } from '../../src/actions/RoomUnitOfWork.js';
import { ACTIONS } from '../../src/gameActions/index.js';
import { createRoom, lookupRoomByCode } from '../../src/gameActions/rooms.js';
import { createVoteTopics } from '../../src/gameActions/voteTopics.js';
import { GUEST, HOST, OUTSIDER, openTempStore, seedRoom } from './roomFixture.js';

// The test-facing adapters in gameActions/ that the other tests and the root test fixture
// (tests/fixtures/serverRoom.js) import: each must run the real handler on the real store. The
// unit of work and runRoomAction adapters are exercised by coverageGaps.test and rooms.test.

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

    /** A unit of work for `user`, with the seeded room loaded unless `loadRoom` is false. */
    function workFor(user, { loadRoom = true } = {}) {
        const work = new RoomUnitOfWork({ repositories: store.repositories, store, user, isAdmin: false });
        if (loadRoom) {
            work.loadRoom(seeded.room.id);
        }
        return work;
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
        const work = workFor(OUTSIDER);

        const joined = ACTIONS.join.run(work, { name: 'Otto' });

        assert.equal(joined.already_joined, false);
        assert.equal(joined.player.email, OUTSIDER.email);
        assert.equal(joined.player.name, 'Otto');
    });

    test('room, player and scoring action objects all reach their services', () => {
        const work = workFor(HOST);

        ACTIONS['set-game-mode'].run(work, { game_mode: 'vengeance' });
        ACTIONS['make-host'].run(work, { player_id: seeded.guest.id });
        ACTIONS.start.run(work, {});
        ACTIONS['end-game'].run(work, {});
        ACTIONS['play-again'].run(work, {});

        assert.equal(work.room.game_mode, 'vengeance');
        assert.equal(work.room.host_player_id, seeded.guest.id);
        assert.equal(work.room.status, 'waiting');
        assert.equal(work.room.game_number, 2);
    });

    // --- Rooms -----------------------------------------------------------

    test('createRoom parses the body and creates the room', () => {
        const work = workFor(GUEST, { loadRoom: false });

        const { player } = createRoom(work, { max_score: 120, name: 'Gus' });

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

    // --- Vote topics -----------------------------------------------------

    test('createVoteTopics resolves make-host through a runner on the context', () => {
        const context = { store, hub: SILENT_HUB, config: { adminEmails: new Set() }, logger: console };
        const topic = createVoteTopics(context)['make-host'];

        const result = topic.resolve(seeded.room.id, seeded.guest.id);

        assert.equal(result.status, 200);
        assert.equal(result.body.room.host_player_id, seeded.guest.id);
        assert.equal(store.getRecord('GameRoom', seeded.room.id).host_email, GUEST.email);
    });
});
