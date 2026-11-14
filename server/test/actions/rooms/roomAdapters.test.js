import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { RoomUnitOfWork } from '../../../src/actions/RoomUnitOfWork.js';
import {
    closeAction,
    createRoom,
    deleteAction,
    lookupRoomByCode,
    setGameModeAction,
    startAction,
} from '../../../src/gameActions/rooms.js';
import { OPEN_STATUSES } from '../../../src/domain/entities.js';
import { api, devLogin, startTestServer } from '../../helpers.js';
import { GUEST, HOST, openTempStore, seedRoom } from '../roomFixture.js';

// The old function API in gameActions/rooms.js, kept as adapters over RoomService and the room
// handlers for the root test fixture and the callers P3.3 moves, plus the by-code route's handling
// of an unexpected failure.

describe('gameActions/rooms.js adapters', () => {
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

    function workFor(user) {
        return new RoomUnitOfWork({ repositories: store.repositories, store, user, isAdmin: false });
    }

    test('the action objects keep their access and statuses', () => {
        assert.deepEqual(
            [setGameModeAction, startAction, closeAction, deleteAction].map((action) => {
                return [action.access, action.allowedStatuses];
            }),
            [['host', OPEN_STATUSES], ['host', ['waiting']], ['host', null], ['host', null]],
        );
    });

    test('an action object runs its handler on the unit of work', () => {
        const work = workFor(HOST);
        work.loadRoom(seeded.room.id);

        setGameModeAction.run(work, { game_mode: 'vengeance' });

        assert.equal(work.room.game_mode, 'vengeance');
    });

    test('createRoom parses the body and creates the room', () => {
        const work = workFor(GUEST);

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

    test('lookupRoomByCode rethrows an error that isn\'t an ActionError', () => {
        const failure = new Error('disk on fire');
        store.repositories.rooms.findByCode = () => {
            throw failure;
        };

        assert.throws(() => lookupRoomByCode(store, GUEST, 'ABCDEF'), failure);
    });
});

describe('GET /api/rooms/by-code/:code', () => {
    let server;
    let cookie;

    before(async () => {
        server = await startTestServer();
        cookie = await devLogin(server.baseUrl, 'ann@example.com', 'Ann');
    });

    after(async () => {
        await server.stop();
    });

    test('a store failure is a server error, not a missing room', async () => {
        const rooms = server.instance.store.repositories.rooms;
        const originalFindByCode = rooms.findByCode;
        rooms.findByCode = () => {
            throw new Error('disk on fire');
        };

        let response;
        try {
            response = await api(server.baseUrl, 'GET', '/api/rooms/by-code/ABCDEF', { cookie });
        } finally {
            rooms.findByCode = originalFindByCode;
        }

        assert.equal(response.status, 500);
    });
});
