// Tests for the never-throwing localStorage helpers. Run with `npm test`.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    getLocalStorage,
    readJson,
    readLocalJson,
    removeLocal,
    writeJson,
    writeLocalJson,
} from '../src/lib/safeStorage.js';

function makeStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        getItem: (key) => (values.has(key) ? values.get(key) : null),
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: (key) => values.delete(key),
        values,
    };
}

function makeThrowingStorage() {
    const fail = () => {
        throw new Error('blocked');
    };
    return { getItem: fail, setItem: fail, removeItem: fail };
}

afterEach(() => {
    delete globalThis.window;
});

test('readJson parses stored JSON and falls back for missing, undefined and corrupt values', () => {
    const storage = makeStorage({ a: '{"n":1}', bad: '{oops' });

    assert.deepEqual(readJson(storage, 'a', null), { n: 1 });
    assert.equal(readJson(storage, 'missing', 'fallback'), 'fallback');
    assert.equal(readJson({ getItem: () => undefined }, 'a', 'fallback'), 'fallback');
    assert.equal(readJson(storage, 'bad', 'fallback'), 'fallback');
});

test('readJson and writeJson fall back on throwing storage', () => {
    const storage = makeThrowingStorage();

    assert.equal(readJson(storage, 'a', 'fallback'), 'fallback');
    assert.equal(writeJson(storage, 'a', 1), false);
});

test('writeJson stores JSON and reports success', () => {
    const storage = makeStorage();

    assert.equal(writeJson(storage, 'a', { n: 2 }), true);
    assert.equal(storage.values.get('a'), '{"n":2}');
});

test('the local helpers read, write and remove through a working localStorage', () => {
    const storage = makeStorage();
    globalThis.window = { localStorage: storage };

    assert.equal(getLocalStorage(), storage);
    assert.equal(writeLocalJson('k', [1]), true);
    assert.deepEqual(readLocalJson('k', null), [1]);
    removeLocal('k');
    assert.equal(readLocalJson('k', 'gone'), 'gone');
});

test('the local helpers survive a throwing localStorage', () => {
    globalThis.window = { localStorage: makeThrowingStorage() };

    assert.equal(readLocalJson('k', 'fallback'), 'fallback');
    assert.equal(writeLocalJson('k', 1), false);
    assert.doesNotThrow(() => removeLocal('k'));
});

test('the local helpers survive a localStorage that throws when accessed', () => {
    globalThis.window = {
        get localStorage() {
            throw new Error('SecurityError');
        },
    };

    assert.equal(getLocalStorage(), null);
    assert.equal(readLocalJson('k', 'fallback'), 'fallback');
    assert.equal(writeLocalJson('k', 1), false);
    assert.doesNotThrow(() => removeLocal('k'));
});

test('the local helpers survive a missing window', () => {
    assert.equal(getLocalStorage(), null);
    assert.equal(readLocalJson('k', 'fallback'), 'fallback');
    assert.equal(writeLocalJson('k', 1), false);
    assert.doesNotThrow(() => removeLocal('k'));
});
