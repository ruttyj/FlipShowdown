// What one chat send is on the wire: one ChatMessage per recipient. This file is the only place that
// turns a send into those records and those records back into the one thing a player sees.

import { EMPTY_EMOJI_QUEUE, enqueueEmoji } from './emojiQueue.js';

// --- Sending ---------------------------------------------------------------------

/**
 * Sends one message per recipient, in order, and carries on past a failure, so one player's lost
 * message doesn't cost the others theirs (X60).
 *
 * @param {(body: object) => Promise<unknown>} createMessage
 * @param {{roomId: string, senderId: string, emoji: string, message: string, recipientIds: string[]}} send
 * @returns {Promise<{sentIds: string[], failedIds: string[]}>}
 */
export async function deliverSend(createMessage, { roomId, senderId, emoji, message, recipientIds }) {
    const sentIds = [];
    const failedIds = [];
    for (const recipientId of recipientIds) {
        try {
            await createMessage({
                room_id: roomId,
                sender_id: senderId,
                recipient_id: recipientId,
                emoji,
                message: message || '',
            });
            sentIds.push(recipientId);
        } catch (error) {
            console.error('[CHAT] Failed to send:', error);
            failedIds.push(recipientId);
        }
    }
    return { sentIds, failedIds };
}

function joinedNames(playerIds, players) {
    const names = [];
    for (const playerId of playerIds) {
        const player = players.find(candidate => candidate.id === playerId);
        names.push(player?.name || 'Someone');
    }
    return names.join(', ');
}

/** The toast for a send that didn't reach everyone, or null if it did. */
export function sendFailureMessage({ sentIds, failedIds }, players) {
    if (failedIds.length === 0) {
        return null;
    }
    if (sentIds.length === 0) {
        return 'Failed to send';
    }
    return `Sent to ${joinedNames(sentIds, players)}, but not to ${joinedNames(failedIds, players)}`;
}

// --- Receiving -------------------------------------------------------------------

/** A player's display name in an emoji caption: "You" for me, "Someone" for a player who left. */
function chatNameFor(playerId, players, myPlayer) {
    if (myPlayer && playerId === myPlayer.id) {
        return 'You';
    }
    const player = players.find(p => p.id === playerId);
    return player?.name || 'Someone';
}

/** The EmojiAnimation item (shape in emojiQueue.js) for one ChatMessage. */
function toEmojiItem(message, players, myPlayer) {
    return {
        id: message.id,
        emoji: message.emoji,
        message: message.message || '',
        senderId: message.sender_id,
        sender: chatNameFor(message.sender_id, players, myPlayer),
        recipients: [{ id: message.recipient_id, name: chatNameFor(message.recipient_id, players, myPlayer) }],
        isForMe: Boolean(myPlayer) && message.recipient_id === myPlayer.id,
    };
}

/**
 * The one item to show for the messages that arrived together. The parts of a send to several players
 * merge into one item via enqueueEmoji. When different sends arrive in the same update only one can be
 * shown: the newest for me, else the newest.
 */
export function pickEmojiItem(newMessages, players, myPlayer) {
    let queue = EMPTY_EMOJI_QUEUE;
    for (const message of newMessages) {
        queue = enqueueEmoji(queue, toEmojiItem(message, players, myPlayer));
    }

    const items = queue.current ? [queue.current, ...queue.pending] : [];
    const itemsForMe = items.filter(item => item.isForMe);
    if (itemsForMe.length > 0) {
        return itemsForMe[itemsForMe.length - 1];
    }
    return items[items.length - 1] ?? null;
}
