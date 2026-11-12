// Tests for the auto-join helpers: the default player name and the per-room "left or kicked"
// flag (decision X3). Run with `npm test`.

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPlayerName, forgetLeftRoom, hasLeftRoom, rememberLeftRoom } from '../src/lib/autoJoin.js';

// --- Fixtures ----------------------------------------------------------------
// safeStorage reaches localStorage through `window`, which node doesn't have.

function createMemoryStorage() {
    const values = new Map();
    return {
        getItem: (key) => (values.has(key) ? values.get(key) : null),
        setItem: (key, value) => {
            values.set(key, String(value));
        },
        removeItem: (key) => {
            values.delete(key);
        },
        keys: () => [...values.keys()],
    };
}

function createThrowingStorage() {
    const fail = () => {
        throw new Error('Storage blocked');
    };
    return { getItem: fail, setItem: fail, removeItem: fail };
}

let storage;

beforeEach(() => {
    storage = createMemoryStorage();
    globalThis.window = { localStorage: storage };
});

afterEach(() => {
    delete globalThis.window;
});

// --- defaultPlayerName -------------------------------------------------------

test('full_name wins over the email', () => {
    assert.equal(defaultPlayerName({ full_name: 'Ada Lovelace', email: 'ada@example.com' }), 'Ada Lovelace');
});

test('without a full_name the part of the email before @ is used', () => {
    assert.equal(defaultPlayerName({ full_name: null, email: 'ada.l@example.com' }), 'ada.l');
    assert.equal(defaultPlayerName({ email: 'bob@example.com' }), 'bob');
    assert.equal(defaultPlayerName({ full_name: '', email: 'cy@example.com' }), 'cy');
});

test('a full_name of only spaces falls back to the email name', () => {
    assert.equal(defaultPlayerName({ full_name: '   ', email: 'dee@example.com' }), 'dee');
});

test('a long full_name is kept whole (the server truncates it)', () => {
    const longName = 'N'.repeat(120);
    assert.equal(defaultPlayerName({ full_name: longName, email: 'n@example.com' }), longName);
});

// --- Left-room flag ----------------------------------------------------------

test('a room is not marked as left until remembered', () => {
    assert.equal(hasLeftRoom('ABC234', 'room-1'), false);
});

test('a remembered room is marked as left, and only that room', () => {
    rememberLeftRoom('ABC234', 'room-1');

    assert.equal(hasLeftRoom('ABC234', 'room-1'), true);
    assert.equal(hasLeftRoom('XYZ789', 'room-2'), false);
});

test('the flag ignores the case and spaces of the code, like the server lookup', () => {
    rememberLeftRoom(' abc234 ', 'room-1');

    assert.equal(hasLeftRoom('ABC234', 'room-1'), true);
});

test('forgetting a room clears its flag and leaves others alone', () => {
    rememberLeftRoom('ABC234', 'room-1');
    rememberLeftRoom('XYZ789', 'room-2');

    forgetLeftRoom('ABC234');

    assert.equal(hasLeftRoom('ABC234', 'room-1'), false);
    assert.equal(hasLeftRoom('XYZ789', 'room-2'), true);
    assert.equal(storage.keys().length, 1);
});

test('a missing room code or room id is never marked as left', () => {
    rememberLeftRoom(null, 'room-1');
    rememberLeftRoom('ABC234', null);

    assert.equal(hasLeftRoom(null, 'room-1'), false);
    assert.equal(hasLeftRoom('ABC234', null), false);
    assert.equal(storage.keys().length, 0);
});

test('blocked storage never throws: nothing is remembered', () => {
    globalThis.window = { localStorage: createThrowingStorage() };

    assert.doesNotThrow(() => rememberLeftRoom('ABC234', 'room-1'));
    assert.doesNotThrow(() => forgetLeftRoom('ABC234'));
    assert.equal(hasLeftRoom('ABC234', 'room-1'), false);
});

// X3b: codes are reused once a room closes, so the flag must not carry over to a new room.
test('a flag from a closed room does not hold back a new room that reuses its code', () => {
    rememberLeftRoom('ABC234', 'old-room');

    assert.equal(hasLeftRoom('ABC234', 'new-room'), false);
    assert.equal(hasLeftRoom('ABC234', 'old-room'), true);
});
