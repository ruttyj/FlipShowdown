import test from 'node:test';
import assert from 'node:assert/strict';
import {
    EMPTY_EMOJI_QUEUE,
    advanceEmojiQueue,
    emojiCaption,
    enqueueEmoji,
    isSameEmojiItem,
} from '../src/lib/emojiQueue.js';
import {
    IDLE_CUE_STATE,
    applyTitleCue,
    clearTitleCue,
    vibrationFor,
} from '../src/lib/attentionCues.js';
import { byeMessage, handleTabMessage, helloMessage, presentMessage } from '../src/lib/duplicateTab.js';
import { readJson, writeJson } from '../src/lib/safeStorage.js';

function fakeStorage(initial = {}) {
    const data = { ...initial };
    return {
        getItem: (key) => (key in data ? data[key] : null),
        setItem: (key, value) => {
            data[key] = value;
        },
    };
}

const throwingStorage = {
    getItem: () => {
        throw new Error('blocked');
    },
    setItem: () => {
        throw new Error('blocked');
    },
};

test('emoji queue shows the first item immediately and queues the rest in order', () => {
    let queue = enqueueEmoji(EMPTY_EMOJI_QUEUE, { emoji: 'a' });
    queue = enqueueEmoji(queue, { emoji: 'b' });
    queue = enqueueEmoji(queue, { emoji: 'c' });
    assert.equal(queue.current.emoji, 'a');
    assert.deepEqual(queue.pending.map(i => i.emoji), ['b', 'c']);

    queue = advanceEmojiQueue(queue);
    assert.equal(queue.current.emoji, 'b');
    queue = advanceEmojiQueue(queue);
    assert.equal(queue.current.emoji, 'c');
    queue = advanceEmojiQueue(queue);
    assert.equal(queue.current, null);
    assert.deepEqual(queue.pending, []);
});

test('emoji item sameness uses id when given, otherwise the fields', () => {
    assert.equal(isSameEmojiItem({ emoji: 'a', sender: 's' }, { emoji: 'a', sender: 's' }), true);
    assert.equal(isSameEmojiItem({ emoji: 'a' }, { emoji: 'b' }), false);
    assert.equal(isSameEmojiItem({ id: 1, emoji: 'a' }, { id: 2, emoji: 'a' }), false);
    assert.equal(isSameEmojiItem(null, { emoji: 'a' }), false);
});

function sendPart(recipientId, overrides = {}) {
    return {
        emoji: '🎉',
        message: '',
        sender: 'Sam',
        senderId: 'sam',
        recipients: [{ id: recipientId, name: recipientId }],
        isForMe: false,
        ...overrides,
    };
}

test('emoji queue merges the per-recipient parts of one send into one item', () => {
    let queue = enqueueEmoji(EMPTY_EMOJI_QUEUE, sendPart('alex'));
    queue = enqueueEmoji(queue, sendPart('You', { isForMe: true }));
    assert.deepEqual(queue.pending, []);
    assert.equal(emojiCaption(queue.current), 'Sam → alex, You');
    assert.equal(queue.current.isForMe, true);

    // A different send waits; the next part of it merges into the waiting item.
    queue = enqueueEmoji(queue, sendPart('alex', { emoji: '🔥' }));
    queue = enqueueEmoji(queue, sendPart('bo', { emoji: '🔥' }));
    assert.equal(queue.pending.length, 1);
    assert.equal(emojiCaption(queue.pending[0]), 'Sam → alex, bo');

    // The same thing to the same player again is a new send.
    queue = enqueueEmoji(queue, sendPart('bo', { emoji: '🔥' }));
    assert.equal(queue.pending.length, 2);
});

test('title cue only applies while hidden and does not stack prefixes', () => {
    assert.equal(applyTitleCue(IDLE_CUE_STATE, 'Flip 7', 'Your turn', false), IDLE_CUE_STATE);

    const first = applyTitleCue(IDLE_CUE_STATE, 'Flip 7', 'Your turn', true);
    assert.equal(first.title, '• Your turn — Flip 7');

    const second = applyTitleCue(first, '• Your turn — Flip 7', 'Game over', true);
    assert.equal(second.title, '• Game over — Flip 7');
    assert.equal(second.baseTitle, 'Flip 7');
    assert.equal(clearTitleCue(), IDLE_CUE_STATE);
});

test('only important cue kinds vibrate', () => {
    assert.ok(vibrationFor('turn'));
    assert.ok(vibrationFor('gameStart'));
    assert.ok(vibrationFor('gameEnd'));
    assert.equal(vibrationFor('chat'), null);
});

test('hello from another tab in the same room is a duplicate and gets a reply', () => {
    const result = handleTabMessage(helloMessage('r1', 'other'), 'r1', 'me');
    assert.equal(result.isDuplicate, true);
    assert.deepEqual(result.reply, presentMessage('r1', 'me'));
});

test('present from another tab is a duplicate with no reply', () => {
    const result = handleTabMessage(presentMessage('r1', 'other'), 'r1', 'me');
    assert.deepEqual(result, { isDuplicate: true, reply: null });
});

test('bye from another tab is not a duplicate and needs no reply', () => {
    const result = handleTabMessage(byeMessage('r1', 'other'), 'r1', 'me');
    assert.deepEqual(result, { isDuplicate: false, reply: null });
});

test('duplicate-tab ignores own, other-room and malformed messages', () => {
    const ignored = { isDuplicate: false, reply: null };
    assert.deepEqual(handleTabMessage(helloMessage('r1', 'me'), 'r1', 'me'), ignored);
    assert.deepEqual(handleTabMessage(helloMessage('r2', 'other'), 'r1', 'me'), ignored);
    assert.deepEqual(handleTabMessage(null, 'r1', 'me'), ignored);
    assert.deepEqual(handleTabMessage({ type: 'x', roomId: 'r1', tabId: 'o' }, 'r1', 'me'), ignored);
});

test('storage helpers survive throwing storage and bad JSON', () => {
    assert.equal(readJson(throwingStorage, 'k', 'fallback'), 'fallback');
    assert.equal(writeJson(throwingStorage, 'k', true), false);
    assert.equal(readJson(fakeStorage({ k: '{bad' }), 'k', 'fallback'), 'fallback');
    assert.equal(writeJson(fakeStorage(), 'k', [1]), true);
});
