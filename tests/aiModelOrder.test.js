// Tests for ordering the AI model picker. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderModelList } from '../src/lib/aiModelOrder.js';

// --- Fixtures ----------------------------------------------------------------

function makeModels() {
    return [
        { id: 'flash', display_name: 'Flash' },
        { id: 'pro', display_name: 'Pro' },
        { id: 'lite', display_name: 'Lite' },
    ];
}

function ids(models) {
    return models.map((model) => model.id);
}

// --- orderModelList ----------------------------------------------------------

test('the chosen model moves first and the rest keep the server order', () => {
    assert.deepEqual(ids(orderModelList(makeModels(), 'lite')), ['lite', 'flash', 'pro']);
});

test('choosing the first model keeps the order', () => {
    assert.deepEqual(ids(orderModelList(makeModels(), 'flash')), ['flash', 'pro', 'lite']);
});

test('an unknown choice keeps the server order', () => {
    assert.deepEqual(ids(orderModelList(makeModels(), 'retired-model')), ['flash', 'pro', 'lite']);
});

test('a null choice keeps the server order', () => {
    assert.deepEqual(ids(orderModelList(makeModels(), null)), ['flash', 'pro', 'lite']);
});

test('an empty model list stays empty', () => {
    assert.deepEqual(orderModelList([], 'pro'), []);
});

test('does not mutate the input list', () => {
    const models = makeModels();
    const before = structuredClone(models);

    orderModelList(models, 'pro');

    assert.deepEqual(models, before);
});
