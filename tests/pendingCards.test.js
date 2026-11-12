// Tests for the pending-cards sessionStorage helpers. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    browserSessionStorage,
    clearOtherGamesPendingCards,
    clearPendingCards,
    clearRoomPendingCards,
    listPendingRounds,
    loadPendingCards,
    pendingCardsKey,
    pendingCardsScope,
    savePendingCards,
} from '../src/lib/pendingCards.js';

function makeStorage() {
    const values = new Map();
    return {
        getItem: (key) => (values.has(key) ? values.get(key) : null),
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: (key) => values.delete(key),
        key: (index) => [...values.keys()][index] ?? null,
        get length() {
            return values.size;
        },
        values,
    };
}

function makeThrowingStorage() {
    const fail = () => {
        throw new Error('blocked');
    };
    return { getItem: fail, setItem: fail, removeItem: fail };
}

const CARDS = [{ value: '7', type: 'number' }, { value: 'x2', type: 'modifier' }];

test('key includes room and round', () => {
    assert.equal(pendingCardsKey('r1', 3), 'flip7_pending_cards:r1:3');
});

// --- Games in the same room (X5) ----------------------------------------------

const GAME_1 = pendingCardsScope('r1', 1);
const GAME_2 = pendingCardsScope('r1', 2);

test('the scope names the room and the game, and a missing game number counts as game 1', () => {
    assert.equal(GAME_2, 'r1:g2');
    assert.equal(pendingCardsKey(GAME_2, 3), 'flip7_pending_cards:r1:g2:3');
    assert.equal(pendingCardsScope('r1', undefined), GAME_1);
    assert.equal(pendingCardsScope('r1', null), GAME_1);
});

test('a draft from one game does not load or list in the next game of the same room', () => {
    const storage = makeStorage();
    savePendingCards(storage, GAME_1, 3, { source: 'manual', cards: CARDS });

    assert.equal(loadPendingCards(storage, GAME_2, 3), null);
    assert.deepEqual(listPendingRounds(storage, GAME_2), []);
    assert.deepEqual(listPendingRounds(storage, GAME_1), [3]);
});

test('drafts saved under the old room-and-round key are not listed for any game', () => {
    const storage = makeStorage();
    storage.setItem('flip7_pending_cards:r1:3', JSON.stringify({ source: 'manual', cards: CARDS }));

    assert.deepEqual(listPendingRounds(storage, GAME_1), []);
    assert.equal(loadPendingCards(storage, GAME_1, 3), null);
});

test('clearing other games keeps this game and other rooms, and drops earlier games and old keys', () => {
    const storage = makeStorage();
    savePendingCards(storage, GAME_1, 3, { source: 'manual', cards: CARDS });
    savePendingCards(storage, GAME_2, 1, { source: 'manual', cards: CARDS });
    savePendingCards(storage, pendingCardsScope('r2', 1), 3, { source: 'manual', cards: CARDS });
    storage.setItem('flip7_pending_cards:r1:3', '{}');
    storage.setItem('unrelated', 'x');

    clearOtherGamesPendingCards(storage, 'r1', GAME_2);

    assert.deepEqual([...storage.values.keys()].sort(), [
        'flip7_pending_cards:r1:g2:1',
        'flip7_pending_cards:r2:g1:3',
        'unrelated',
    ]);
});

test('clearing the room drops every game and old key of that room only', () => {
    const storage = makeStorage();
    savePendingCards(storage, GAME_1, 3, { source: 'manual', cards: CARDS });
    savePendingCards(storage, GAME_2, 1, { source: 'manual', cards: CARDS });
    savePendingCards(storage, pendingCardsScope('r2', 1), 3, { source: 'manual', cards: CARDS });
    storage.setItem('flip7_pending_cards:r1:3', '{}');

    clearRoomPendingCards(storage, 'r1');

    assert.deepEqual([...storage.values.keys()], ['flip7_pending_cards:r2:g1:3']);
});

test('clearing other games or the room never throws on missing or throwing storage', () => {
    for (const storage of [null, makeThrowingStorage()]) {
        assert.doesNotThrow(() => clearOtherGamesPendingCards(storage, 'r1', GAME_2));
        assert.doesNotThrow(() => clearRoomPendingCards(storage, 'r1'));
    }
});

test('saved cards load back for the same room and round', () => {
    const storage = makeStorage();
    savePendingCards(storage, 'r1', 2, { source: 'scanner', cards: CARDS });

    assert.deepEqual(loadPendingCards(storage, 'r1', 2), { source: 'scanner', cards: CARDS });
});

test('other rounds and rooms are kept apart', () => {
    const storage = makeStorage();
    savePendingCards(storage, 'r1', 2, { source: 'manual', cards: CARDS });

    assert.equal(loadPendingCards(storage, 'r1', 3), null);
    assert.equal(loadPendingCards(storage, 'r2', 2), null);
});

test('clear removes only that round', () => {
    const storage = makeStorage();
    savePendingCards(storage, 'r1', 2, { source: 'manual', cards: CARDS });
    savePendingCards(storage, 'r1', 3, { source: 'manual', cards: CARDS });

    clearPendingCards(storage, 'r1', 2);

    assert.equal(loadPendingCards(storage, 'r1', 2), null);
    assert.notEqual(loadPendingCards(storage, 'r1', 3), null);
});

test('corrupt or wrongly shaped values load as null', () => {
    const storage = makeStorage();
    storage.setItem(pendingCardsKey('r1', 1), '{not json');
    storage.setItem(pendingCardsKey('r1', 2), JSON.stringify({ source: 'camera', cards: [] }));
    storage.setItem(pendingCardsKey('r1', 3), JSON.stringify({ source: 'manual', cards: 'x' }));
    storage.setItem(pendingCardsKey('r1', 4), 'null');

    for (const round of [1, 2, 3, 4]) {
        assert.equal(loadPendingCards(storage, 'r1', round), null);
    }
});

test('missing or throwing storage never throws', () => {
    for (const storage of [null, makeThrowingStorage()]) {
        assert.doesNotThrow(() => savePendingCards(storage, 'r1', 1, { source: 'manual', cards: CARDS }));
        assert.equal(loadPendingCards(storage, 'r1', 1), null);
        assert.doesNotThrow(() => clearPendingCards(storage, 'r1', 1));
    }
});

test('browserSessionStorage returns the global, or null when missing or blocked', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    try {
        const storage = makeStorage();
        Object.defineProperty(globalThis, 'sessionStorage', { value: storage, configurable: true });
        assert.equal(browserSessionStorage(), storage);

        Object.defineProperty(globalThis, 'sessionStorage', { value: undefined, configurable: true });
        assert.equal(browserSessionStorage(), null);

        Object.defineProperty(globalThis, 'sessionStorage', {
            get() {
                throw new Error('SecurityError');
            },
            configurable: true,
        });
        assert.equal(browserSessionStorage(), null);
    } finally {
        if (original) {
            Object.defineProperty(globalThis, 'sessionStorage', original);
        } else {
            delete globalThis.sessionStorage;
        }
    }
});

test('listing and clearing survive storage that throws while iterating keys', () => {
    const scope = pendingCardsScope('r1', 1);
    const blocked = {
        length: 1,
        key: () => {
            throw new Error('blocked');
        },
        removeItem: () => {
            throw new Error('blocked');
        },
    };

    assert.deepEqual(listPendingRounds(blocked, scope), []);
    assert.doesNotThrow(() => clearRoomPendingCards(blocked, 'r1'));
});

test('clearing the room survives removeItem throwing', () => {
    const storage = makeStorage();
    savePendingCards(storage, 'r1', 1, { source: 'manual', cards: CARDS });
    storage.removeItem = () => {
        throw new Error('blocked');
    };

    assert.doesNotThrow(() => clearRoomPendingCards(storage, 'r1'));
});
