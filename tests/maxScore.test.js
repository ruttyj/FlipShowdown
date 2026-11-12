import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_MAX_SCORE,
    parseMaxScore,
    readCreateAfterLogin,
} from '../src/lib/maxScore.js';

test('parseMaxScore takes the integer part of what was entered', () => {
    assert.equal(parseMaxScore('150'), 150);
    assert.equal(parseMaxScore('150abc'), 150);
    assert.equal(parseMaxScore('1e3'), 1);
    assert.equal(parseMaxScore('150.7'), 150);
    assert.equal(parseMaxScore(300), 300);
});

test('parseMaxScore falls back to 200 for missing, NaN, zero and negative values', () => {
    assert.equal(DEFAULT_MAX_SCORE, 200);
    assert.equal(parseMaxScore(null), 200);
    assert.equal(parseMaxScore(undefined), 200);
    assert.equal(parseMaxScore(''), 200);
    assert.equal(parseMaxScore('abc'), 200);
    assert.equal(parseMaxScore('0'), 200);
    assert.equal(parseMaxScore('-5'), 200);
    assert.equal(parseMaxScore(-5), 200);
});

test('readCreateAfterLogin reports the request and its max score', () => {
    assert.deepEqual(readCreateAfterLogin('?create=1&max_score=150'), { maxScore: 150, gameMode: 'classic' });
    assert.deepEqual(readCreateAfterLogin('?create=1'), { maxScore: 200, gameMode: 'classic' });
    assert.deepEqual(readCreateAfterLogin('?create=1&max_score=-5'), { maxScore: 200, gameMode: 'classic' });
    assert.deepEqual(readCreateAfterLogin('?create=1&max_score=0'), { maxScore: 200, gameMode: 'classic' });
    assert.deepEqual(readCreateAfterLogin('?create=1&max_score=150abc'), { maxScore: 150, gameMode: 'classic' });
    assert.deepEqual(readCreateAfterLogin('?create=1&max_score=1e3'), { maxScore: 1, gameMode: 'classic' });
});

test('readCreateAfterLogin carries the chosen mode, and reads an unknown one as classic', () => {
    assert.equal(readCreateAfterLogin('?create=1&game_mode=vengeance').gameMode, 'vengeance');
    assert.equal(readCreateAfterLogin('?create=1&game_mode=brutal').gameMode, 'brutal');
    assert.equal(readCreateAfterLogin('?create=1&game_mode=nonsense').gameMode, 'classic');
});

test('readCreateAfterLogin returns null without create=1', () => {
    assert.equal(readCreateAfterLogin(''), null);
    assert.equal(readCreateAfterLogin('?max_score=150'), null);
    assert.equal(readCreateAfterLogin('?create=0&max_score=150'), null);
});
