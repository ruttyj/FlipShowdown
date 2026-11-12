import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildRoomStats } from '../src/roomStats.js';

// --- Builders --------------------------------------------------------------

function makeRoom(overrides = {}) {
    return { id: 'room-1', code: 'FW6XK6', status: 'playing', current_round: 4, max_score: 200, ...overrides };
}

function makeSocket(email, roomIds, overrides = {}) {
    return {
        identity: { email },
        isSubscribed: true,
        isLive: true,
        rooms: new Set(roomIds),
        allRooms: false,
        ...overrides,
    };
}

/** Presence players as the hub keeps them: only `online` matters here. */
function presenceOf(...online) {
    return { players: online.map((isOnline, index) => ({ player_id: `p${index}`, online: isOnline })) };
}

/** The slice of the hub's context buildRoomStats reads. */
function makeContext({ rooms = [], presence = {}, sockets = [] }) {
    const roomsById = new Map(rooms.map((room) => [room.id, room]));
    return {
        store: { getRecord: (entity, id) => (entity === 'GameRoom' ? roomsById.get(id) ?? null : null) },
        presence: new Map(Object.entries(presence)),
        wss: { clients: new Set(sockets) },
    };
}

// --- Players online --------------------------------------------------------

describe('players online', () => {
    test('counts each live socket subscribed to a room', () => {
        const context = makeContext({
            sockets: [makeSocket('ann@example.com', ['room-1']), makeSocket('ben@example.com', ['room-2'])],
        });

        assert.equal(buildRoomStats(context).playersOnline, 2);
    });

    test('counts one person with two tabs or devices once', () => {
        const context = makeContext({
            sockets: [makeSocket('ann@example.com', ['room-1']), makeSocket('ann@example.com', ['room-1'])],
        });

        assert.equal(buildRoomStats(context).playersOnline, 1);
    });

    test('leaves out hidden tabs, admin "*" watchers, sockets before hello and people in no room', () => {
        const context = makeContext({
            sockets: [
                makeSocket('hidden@example.com', ['room-1'], { isLive: false }),
                makeSocket('admin@example.com', [], { allRooms: true }),
                makeSocket('new@example.com', ['room-1'], { isSubscribed: false }),
                makeSocket('home@example.com', []),
            ],
        });

        assert.equal(buildRoomStats(context).playersOnline, 0);
    });
});

// --- Rooms in play -----------------------------------------------------------

describe('rooms in play', () => {
    test('a room with someone online is a row of codes and counts, never ids or emails', () => {
        const context = makeContext({
            rooms: [makeRoom()],
            presence: { 'room-1': presenceOf(true, true, false) },
        });

        const stats = buildRoomStats(context);

        assert.equal(stats.roomsLive, 1);
        assert.deepEqual(stats.rooms, [
            { code: 'FW6XK6', status: 'playing', round: 4, maxScore: 200, online: 2, players: 3 },
        ]);
    });

    test('rooms nobody is online in, closed rooms and deleted rooms are left out', () => {
        const context = makeContext({
            rooms: [makeRoom({ id: 'quiet' }), makeRoom({ id: 'closed', status: 'closed' })],
            presence: { quiet: presenceOf(false), closed: presenceOf(true), deleted: presenceOf(true) },
        });

        const stats = buildRoomStats(context);

        assert.equal(stats.roomsLive, 0);
        assert.deepEqual(stats.rooms, []);
    });

    test('lists the busiest room first, and equal rooms by code', () => {
        const context = makeContext({
            rooms: [
                makeRoom({ id: 'a', code: 'ZZ81TR' }),
                makeRoom({ id: 'b', code: 'QP2M9A', status: 'waiting' }),
                makeRoom({ id: 'c', code: 'LK4T2B', status: 'finished' }),
            ],
            presence: { a: presenceOf(true), b: presenceOf(true, true), c: presenceOf(true) },
        });

        const codes = buildRoomStats(context).rooms.map((room) => room.code);

        assert.deepEqual(codes, ['QP2M9A', 'LK4T2B', 'ZZ81TR']);
    });
});
