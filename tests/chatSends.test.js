import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliverSend, pickEmojiItem, sendFailureMessage } from '../src/lib/chatSends.js';

const PLAYERS = [{ id: 'me', name: 'Me' }, { id: 'bo', name: 'Bo' }, { id: 'cy', name: 'Cy' }];
const ME = PLAYERS[0];

function send(recipientIds) {
    return { roomId: 'r', senderId: 'me', emoji: '🎉', message: undefined, recipientIds };
}

function message(id, recipientId, fields = {}) {
    return { id, sender_id: 'bo', recipient_id: recipientId, emoji: '🎉', ...fields };
}

// --- deliverSend -----------------------------------------------------------------

test('a send is one message per recipient, in order, with a blank message for none', async () => {
    const bodies = [];

    const outcome = await deliverSend(async (body) => {
        bodies.push(body);
    }, send(['bo', 'cy']));

    assert.deepEqual(outcome, { sentIds: ['bo', 'cy'], failedIds: [] });
    assert.deepEqual(bodies[0], { room_id: 'r', sender_id: 'me', recipient_id: 'bo', emoji: '🎉', message: '' });
    assert.equal(bodies[1].recipient_id, 'cy');
});

test('a failure for one recipient does not stop the next (X60)', async (context) => {
    context.mock.method(console, 'error', () => {});
    const tried = [];

    const outcome = await deliverSend(async ({ recipient_id: recipientId }) => {
        tried.push(recipientId);
        if (recipientId === 'bo') {
            throw new Error('offline');
        }
    }, send(['bo', 'cy']));

    assert.deepEqual(tried, ['bo', 'cy']);
    assert.deepEqual(outcome, { sentIds: ['cy'], failedIds: ['bo'] });
});

// --- sendFailureMessage ----------------------------------------------------------

test('a send that reached everyone says nothing', () => {
    assert.equal(sendFailureMessage({ sentIds: ['bo'], failedIds: [] }, PLAYERS), null);
});

test('a send that reached nobody stays the plain message', () => {
    assert.equal(sendFailureMessage({ sentIds: [], failedIds: ['bo'] }, PLAYERS), 'Failed to send');
});

test('a partial send names who got it and who did not', () => {
    assert.equal(
        sendFailureMessage({ sentIds: ['bo'], failedIds: ['cy', 'gone'] }, PLAYERS),
        'Sent to Bo, but not to Cy, Someone',
    );
});

// --- pickEmojiItem ---------------------------------------------------------------

test('nothing new is nothing to show', () => {
    assert.equal(pickEmojiItem([], PLAYERS, ME), null);
});

test('the parts of one send become one item', () => {
    const item = pickEmojiItem([message('1', 'me'), message('2', 'cy')], PLAYERS, ME);

    assert.equal(item.sender, 'Bo');
    assert.deepEqual(item.recipients, [{ id: 'me', name: 'You' }, { id: 'cy', name: 'Cy' }]);
    assert.equal(item.isForMe, true);
    assert.equal(item.message, '');
});

test('of different sends, the newest for me wins over a newer one for someone else', () => {
    const item = pickEmojiItem(
        [message('1', 'me', { emoji: 'A' }), message('2', 'cy', { emoji: 'B' })],
        PLAYERS,
        ME,
    );

    assert.equal(item.id, '1');
});

test('with none for me, the newest wins, and a sender who left is Someone', () => {
    const item = pickEmojiItem(
        [message('1', 'cy', { emoji: 'A' }), message('2', 'cy', { emoji: 'B', sender_id: 'gone', message: 'hi' })],
        PLAYERS,
        null,
    );

    assert.equal(item.id, '2');
    assert.equal(item.sender, 'Someone');
    assert.equal(item.message, 'hi');
    assert.equal(item.isForMe, false);
});
