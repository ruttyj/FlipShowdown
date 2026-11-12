import { describe, expect, test } from 'vitest';
import {
    COLLAPSED_ROOM_ROWS,
    describeStage,
    keepOrder,
    roomJoinUrl,
    visibleRooms,
} from '../../src/renderer/roomList.js';

function makeRoom(code, overrides = {}) {
    return { code, status: 'playing', round: 2, maxScore: 200, online: 1, players: 2, ...overrides };
}

function codesOf(rooms) {
    return rooms.map((room) => room.code);
}

const TWELVE_ROOMS = Array.from({ length: 12 }, (_, index) => makeRoom(`ROOM${String(index).padStart(2, '0')}`));

// --- Visible rows ------------------------------------------------------------------------

describe('visibleRooms', () => {
    test('collapsed shows the first five, in order', () => {
        const shown = visibleRooms(TWELVE_ROOMS, { isExpanded: false, filter: 'ROOM1' });

        expect(shown).toHaveLength(COLLAPSED_ROOM_ROWS);
        expect(codesOf(shown)).toEqual(codesOf(TWELVE_ROOMS.slice(0, 5)));
    });

    test('expanded shows every room when there is no filter', () => {
        expect(visibleRooms(TWELVE_ROOMS, { isExpanded: true, filter: '  ' })).toHaveLength(12);
    });

    test('the filter matches any part of the code, in any case, ignoring spaces', () => {
        const shown = visibleRooms(TWELVE_ROOMS, { isExpanded: true, filter: ' room 1' });

        expect(codesOf(shown)).toEqual(['ROOM10', 'ROOM11']);
    });
});

// --- Holding the order -------------------------------------------------------------------

describe('keepOrder', () => {
    test('keeps the previous order, drops rooms that left and adds new ones at the end', () => {
        const rooms = [makeRoom('NEW1'), makeRoom('BBB'), makeRoom('AAA')];

        const ordered = keepOrder(['AAA', 'GONE', 'BBB'], rooms);

        expect(codesOf(ordered)).toEqual(['AAA', 'BBB', 'NEW1']);
    });
});

// --- Wording and links -------------------------------------------------------------------

describe('describeStage', () => {
    test('reads like the room screens', () => {
        expect(describeStage(makeRoom('A', { status: 'waiting' }))).toBe('In the lobby');
        expect(describeStage(makeRoom('A', { round: 4 }))).toBe('Round 4 · to 200');
        expect(describeStage(makeRoom('A', { status: 'finished', maxScore: 100 }))).toBe('Game over · to 100');
    });
});

describe('roomJoinUrl', () => {
    test('is the lobby\'s join link on the game link', () => {
        expect(roomJoinUrl('https://x.trycloudflare.com', 'FW6XK6')).toBe('https://x.trycloudflare.com/room/FW6XK6');
    });
});
