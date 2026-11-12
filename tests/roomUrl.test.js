// Tests for the room URL helpers (src/lib/roomUrl.js). Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRoomCode, roomPath } from '../src/lib/roomUrl.js';

test('roomPath puts the code in the path', () => {
    assert.equal(roomPath('3Z7R7L'), '/room/3Z7R7L');
});

test('roomPath escapes characters that would break the path', () => {
    assert.equal(roomPath('A/B?C'), '/room/A%2FB%3FC');
});

test('readRoomCode reads the code from a room path', () => {
    assert.equal(readRoomCode('/room/3Z7R7L'), '3Z7R7L');
    assert.equal(readRoomCode('/room/3Z7R7L/'), '3Z7R7L');
    assert.equal(readRoomCode('/room/A%2FB'), 'A/B');
});

test('readRoomCode is null off a room path', () => {
    for (const pathname of ['/', '/Home', '/room', '/room/', '/room/ABC/extra', '/GameRoom', '/rooms/ABC']) {
        assert.equal(readRoomCode(pathname), null, pathname);
    }
});

test('readRoomCode is null for a malformed escape instead of throwing', () => {
    assert.equal(readRoomCode('/room/%E0%A4%A'), null);
});
