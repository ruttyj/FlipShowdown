// Queue of emoji animations, shown one after another.
// State shape: { current: item | null, pending: item[] }
// An item is { id, emoji, message, sender, senderId, recipients: [{ id, name }], isForMe,
// sequence }; `sender` and the recipient names are display labels ("You" for me).

export const EMPTY_EMOJI_QUEUE = { current: null, pending: [] };

function hasRecipient(item, recipientId) {
    return item.recipients.some((recipient) => recipient.id === recipientId);
}

// A quick send to several players arrives as one ChatMessage per recipient. Consecutive
// parts of the same send merge into one item ("Sam → Alex, Bo") instead of playing once each.
function isSameSend(tail, item) {
    if (!tail || !Array.isArray(tail.recipients) || !Array.isArray(item.recipients)) {
        return false;
    }

    const hasSameContent = tail.senderId === item.senderId
        && tail.emoji === item.emoji
        && tail.message === item.message;
    if (!hasSameContent) {
        return false;
    }

    // Sending the same thing to the same player again is a new send, so it plays again.
    for (const recipient of item.recipients) {
        if (hasRecipient(tail, recipient.id)) {
            return false;
        }
    }
    return true;
}

function mergeSend(tail, item) {
    return {
        ...tail,
        recipients: [...tail.recipients, ...item.recipients],
        isForMe: Boolean(tail.isForMe || item.isForMe),
    };
}

// Shows the item straight away when idle, otherwise waits behind the current one. Another
// part of the send at the back of the queue is merged into it instead.
export function enqueueEmoji(queue, item) {
    if (queue.current === null) {
        return { current: item, pending: queue.pending };
    }

    if (queue.pending.length === 0) {
        if (isSameSend(queue.current, item)) {
            return { current: mergeSend(queue.current, item), pending: [] };
        }
        return { current: queue.current, pending: [item] };
    }

    const lastIndex = queue.pending.length - 1;
    const last = queue.pending[lastIndex];
    if (isSameSend(last, item)) {
        return { current: queue.current, pending: [...queue.pending.slice(0, lastIndex), mergeSend(last, item)] };
    }
    return { current: queue.current, pending: [...queue.pending, item] };
}

// Dismisses the current item and promotes the next waiting one (or goes idle).
export function advanceEmojiQueue(queue) {
    if (queue.pending.length === 0) {
        return EMPTY_EMOJI_QUEUE;
    }
    const [next, ...rest] = queue.pending;
    return { current: next, pending: rest };
}

// Two consecutive prop snapshots are the same message when an id is given and equal,
// or (without ids) when all visible fields are equal.
export function isSameEmojiItem(a, b) {
    if (!a || !b) {
        return false;
    }
    if (a.id !== undefined || b.id !== undefined) {
        return a.id === b.id;
    }
    return a.emoji === b.emoji && a.sender === b.sender && a.message === b.message;
}

/** "Sam → Alex, Bo": who sent the item to whom, with "You" for me. */
export function emojiCaption(item) {
    const recipientNames = item.recipients.map((recipient) => recipient.name);
    return `${item.sender} → ${recipientNames.join(', ')}`;
}
