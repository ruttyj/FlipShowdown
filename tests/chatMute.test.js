// filterIncomingForMute: the behaviour table in docs/decisions.md X44, without React.
import test from 'node:test';
import assert from 'node:assert/strict';
import { filterIncomingForMute } from '../src/lib/chatMute.js';

const ME = 'me';

function chat(id, senderId, recipientId) {
    return { id, sender_id: senderId, recipient_id: recipientId };
}

function idsToPlay(result) {
    return result.messagesToPlay.map(message => message.id);
}

// --- Not muted -------------------------------------------------------------------

test('not muted: everything plays and the button never pulses', () => {
    const messages = [chat('a', 'sam', ME), chat('b', 'sam', 'alex'), chat('c', ME, 'alex')];

    const result = filterIncomingForMute(messages, { isMuted: false, myPlayerId: ME });

    assert.deepEqual(idsToPlay(result), ['a', 'b', 'c']);
    assert.equal(result.shouldPulse, false);
});

// --- Muted -----------------------------------------------------------------------

test('muted: a message to me does not play and pulses', () => {
    const result = filterIncomingForMute([chat('a', 'sam', ME)], { isMuted: true, myPlayerId: ME });

    assert.deepEqual(result, { messagesToPlay: [], shouldPulse: true });
});

test('muted: a message between other players does nothing at all', () => {
    const result = filterIncomingForMute([chat('a', 'sam', 'alex')], { isMuted: true, myPlayerId: ME });

    assert.deepEqual(result, { messagesToPlay: [], shouldPulse: false });
});

test('muted: my own send plays as normal and does not pulse', () => {
    const result = filterIncomingForMute([chat('a', ME, 'alex')], { isMuted: true, myPlayerId: ME });

    assert.deepEqual(idsToPlay(result), ['a']);
    assert.equal(result.shouldPulse, false);
});

test('muted: a send to me and others is dropped whole and pulses', () => {
    const parts = [chat('a', 'sam', 'alex'), chat('b', 'sam', ME), chat('c', 'sam', 'bo')];

    const result = filterIncomingForMute(parts, { isMuted: true, myPlayerId: ME });

    assert.deepEqual(result, { messagesToPlay: [], shouldPulse: true });
});

test('muted: my own send still plays when a message to me arrives in the same update', () => {
    const messages = [chat('a', 'sam', ME), chat('b', ME, 'alex')];

    const result = filterIncomingForMute(messages, { isMuted: true, myPlayerId: ME });

    assert.deepEqual(idsToPlay(result), ['b']);
    assert.equal(result.shouldPulse, true);
});

test('muted without a player of my own: nothing plays and nothing pulses', () => {
    const result = filterIncomingForMute([chat('a', 'sam', 'alex')], { isMuted: true, myPlayerId: undefined });

    assert.deepEqual(result, { messagesToPlay: [], shouldPulse: false });
});

test('no new messages: nothing plays and nothing pulses', () => {
    const result = filterIncomingForMute([], { isMuted: true, myPlayerId: ME });

    assert.deepEqual(result, { messagesToPlay: [], shouldPulse: false });
});
