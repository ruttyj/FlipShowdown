import test from 'node:test';
import assert from 'node:assert/strict';
import { idsWithPlayerFirst } from '../src/lib/turnOrder.js';

const PLAYERS = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

test('the chosen player goes first and the others keep their order', () => {
    assert.deepEqual(idsWithPlayerFirst(PLAYERS, 'c'), ['c', 'a', 'b', 'd']);
});

test('choosing the current first player changes nothing', () => {
    assert.deepEqual(idsWithPlayerFirst(PLAYERS, 'a'), ['a', 'b', 'c', 'd']);
});

test('choosing the last player moves only that player', () => {
    assert.deepEqual(idsWithPlayerFirst(PLAYERS, 'd'), ['d', 'a', 'b', 'c']);
});

test('a single player, and no players', () => {
    assert.deepEqual(idsWithPlayerFirst([{ id: 'a' }], 'a'), ['a']);
    assert.deepEqual(idsWithPlayerFirst([], 'a'), ['a']);
});

test('does not modify the players list', () => {
    const players = [{ id: 'a' }, { id: 'b' }];
    idsWithPlayerFirst(players, 'b');
    assert.deepEqual(players, [{ id: 'a' }, { id: 'b' }]);
});
