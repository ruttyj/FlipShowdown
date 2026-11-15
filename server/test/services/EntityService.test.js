import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { parseListQuery } from '../../src/lib/query.js';
import { EntityService } from '../../src/services/EntityService.js';
import { GUEST, HOST, OUTSIDER, openTempStore, seedRoom } from '../actions/roomFixture.js';

// EntityService on a real temp store with a recording hub: the LOCK_GAME_ENTITIES rules, and the
// events each write sends. lockdown.test.js and api.test.js cover it through the HTTP API.

const ADMIN = { email: 'admin@example.com' };
const ENTITY_NAMES = new Set(['GameRoom', 'Player', 'RoundScore', 'ChatMessage', 'Note']);

/** A hub that records publish and roomMembershipChanged calls in order. */
function createRecordingHub() {
    const calls = [];
    return {
        calls,
        publish: (entityName, type, record) => calls.push(['publish', entityName, type, record.id]),
        roomMembershipChanged: (roomId) => calls.push(['membership', roomId]),
    };
}

describe('EntityService', () => {
    let temp;
    let hub;
    let seeded;

    function createService(lockGameEntities) {
        return new EntityService({
            store: temp.store,
            hub,
            entityNames: ENTITY_NAMES,
            lockGameEntities,
            adminEmails: new Set([ADMIN.email]),
        });
    }

    beforeEach(() => {
        temp = openTempStore();
        hub = createRecordingHub();
        seeded = seedRoom(temp.store);
    });

    afterEach(() => {
        temp.close();
    });

    test('isEntity is true only for the configured names', () => {
        const entities = createService(false);

        assert.equal(entities.isEntity('Note'), true);
        assert.equal(entities.isEntity('Secret'), false);
    });

    describe('with the lock off, or for admins and other entities', () => {
        test('every check passes', () => {
            const cases = [
                { entities: createService(false), user: OUTSIDER, entityName: 'GameRoom' },
                { entities: createService(true), user: ADMIN, entityName: 'GameRoom' },
                { entities: createService(true), user: OUTSIDER, entityName: 'Note' },
            ];
            for (const { entities, user, entityName } of cases) {
                assert.equal(entities.canList(user, entityName, {}), true);
                assert.equal(entities.canGet(user, entityName, 'missing'), true);
                assert.equal(entities.canCreate(user, entityName, {}), true);
                assert.equal(entities.canBulkCreate(user, entityName, [{}]), true);
                assert.equal(entities.canModify(user, entityName), true);
            }
        });
    });

    describe('with the lock on', () => {
        let entities;
        let roomId;

        beforeEach(() => {
            entities = createService(true);
            roomId = seeded.room.id;
        });

        test('a list must name a room the user is in', () => {
            const byRoom = { q: JSON.stringify({ room_id: roomId }) };

            assert.equal(entities.canList(GUEST, 'Player', byRoom), true);
            assert.equal(entities.canList(OUTSIDER, 'Player', byRoom), false);
            assert.equal(entities.canList(GUEST, 'Player', {}), false);
        });

        test('a room list must be by an id or a code of rooms the user is in', () => {
            const byId = { q: JSON.stringify({ id: roomId }) };
            const byCode = { q: JSON.stringify({ code: 'ABCDEF' }) };

            assert.equal(entities.canList(GUEST, 'GameRoom', byId), true);
            assert.equal(entities.canList(OUTSIDER, 'GameRoom', byId), false);
            assert.equal(entities.canList(GUEST, 'GameRoom', byCode), true);
            assert.equal(entities.canList(OUTSIDER, 'GameRoom', byCode), false);
            assert.equal(entities.canList(GUEST, 'GameRoom', { q: JSON.stringify({ code: 'NONE00' }) }), false);
            assert.equal(entities.canList(GUEST, 'GameRoom', { q: JSON.stringify({ code: 5 }) }), false);
        });

        test('a malformed list query passes, so the route answers 400', () => {
            assert.equal(entities.canList(OUTSIDER, 'Player', { q: 'nope' }), true);
        });

        test('a read by id must be of a room the user is in, or a record in one', () => {
            assert.equal(entities.canGet(GUEST, 'GameRoom', roomId), true);
            assert.equal(entities.canGet(OUTSIDER, 'GameRoom', roomId), false);
            assert.equal(entities.canGet(GUEST, 'Player', seeded.host.id), true);
            assert.equal(entities.canGet(OUTSIDER, 'Player', seeded.host.id), false);
            // The route answers 404.
            assert.equal(entities.canGet(OUTSIDER, 'Player', 'missing'), true);
        });

        test('only the user\'s own chat messages may be created', () => {
            const own = { room_id: roomId, sender_id: seeded.guest.id, text: 'hi' };
            const asHost = { room_id: roomId, sender_id: seeded.host.id, text: 'hi' };

            assert.equal(entities.canCreate(GUEST, 'ChatMessage', own), true);
            assert.equal(entities.canCreate(GUEST, 'ChatMessage', asHost), false);
            assert.equal(entities.canCreate(OUTSIDER, 'ChatMessage', own), false);
            assert.equal(entities.canCreate(GUEST, 'ChatMessage', { sender_id: seeded.guest.id }), false);
            assert.equal(entities.canCreate(GUEST, 'Player', {}), false);
            // A body that isn't an object passes, so the route answers 400.
            assert.equal(entities.canCreate(OUTSIDER, 'ChatMessage', []), true);
        });

        test('a bulk create must be all the user\'s own chat messages', () => {
            const own = { room_id: roomId, sender_id: seeded.guest.id, text: 'hi' };
            const asHost = { room_id: roomId, sender_id: seeded.host.id, text: 'hi' };

            assert.equal(entities.canBulkCreate(GUEST, 'ChatMessage', [own, own]), true);
            assert.equal(entities.canBulkCreate(GUEST, 'ChatMessage', [own, asHost]), false);
            assert.equal(entities.canBulkCreate(GUEST, 'GameRoom', [{}]), false);
            assert.equal(entities.canBulkCreate(OUTSIDER, 'ChatMessage', { not: 'an array' }), true);
            assert.equal(entities.canBulkCreate(OUTSIDER, 'ChatMessage', [1]), true);
        });

        test('updates and deletes are for admins only', () => {
            assert.equal(entities.canModify(HOST, 'GameRoom'), false);
            assert.equal(entities.canModify(ADMIN, 'GameRoom'), true);
        });
    });

    describe('reads and writes', () => {
        let entities;

        beforeEach(() => {
            entities = createService(false);
        });

        test('list filters, sorts and pages', () => {
            entities.create('Note', [{ n: 1, kind: 'a' }, { n: 2, kind: 'b' }, { n: 3, kind: 'a' }], HOST.email);

            const query = parseListQuery({ q: JSON.stringify({ kind: 'a' }), sort: '-n', limit: '1' });

            assert.deepEqual(entities.list('Note', query).map((record) => record.n), [3]);
        });

        test('get answers the record or null', () => {
            assert.equal(entities.get('Player', seeded.host.id).id, seeded.host.id);
            assert.equal(entities.get('Player', 'missing'), null);
        });

        test('create publishes each record, and a new Player changes its room\'s membership', () => {
            const [note] = entities.create('Note', [{ text: 'hi' }], HOST.email);
            const [player] = entities.create('Player', [{ room_id: seeded.room.id, email: OUTSIDER.email, name: 'O' }], HOST.email);

            assert.equal(note.created_by, HOST.email);
            assert.deepEqual(hub.calls, [
                ['publish', 'Note', 'create', note.id],
                ['publish', 'Player', 'create', player.id],
                ['membership', seeded.room.id],
            ]);
        });

        test('update publishes the record and answers null when there is none', () => {
            const [note] = entities.create('Note', [{ text: 'hi' }], HOST.email);
            hub.calls.length = 0;

            assert.equal(entities.update('Note', note.id, { text: 'yo' }).text, 'yo');
            assert.equal(entities.update('Note', 'missing', { text: 'yo' }), null);
            assert.deepEqual(hub.calls, [['publish', 'Note', 'update', note.id]]);
        });

        test('a Player moved to another room changes both rooms\' membership', () => {
            const [otherRoom] = temp.store.createRecords('GameRoom', [{ code: 'GHIJKL', status: 'waiting' }], HOST.email);
            hub.calls.length = 0;

            entities.update('Player', seeded.guest.id, { room_id: otherRoom.id });

            assert.deepEqual(hub.calls, [
                ['publish', 'Player', 'update', seeded.guest.id],
                ['membership', seeded.room.id],
                ['membership', otherRoom.id],
            ]);
        });

        test('a Player given to another user changes its room\'s membership once', () => {
            entities.update('Player', seeded.guest.id, { email: OUTSIDER.email });

            assert.deepEqual(hub.calls, [
                ['publish', 'Player', 'update', seeded.guest.id],
                ['membership', seeded.room.id],
            ]);
        });

        test('a Player update that moves nothing changes no membership', () => {
            entities.update('Player', seeded.guest.id, { name: 'Renamed' });

            assert.deepEqual(hub.calls, [['publish', 'Player', 'update', seeded.guest.id]]);
        });

        test('remove publishes the record as it was and answers null when there was none', () => {
            const removed = entities.remove('Player', seeded.guest.id);

            assert.equal(removed.id, seeded.guest.id);
            assert.equal(entities.remove('Player', seeded.guest.id), null);
            assert.deepEqual(hub.calls, [
                ['publish', 'Player', 'delete', seeded.guest.id],
                ['membership', seeded.room.id],
            ]);
        });
    });
});
