// Saved quick-send combos ({ emoji, message, recipients, toEveryone? }), up to
// MAX_QUICK_SENDS per room. Pure list operations; useQuickSends (hooks/useRoomChat.jsx) stores the
// result in localStorage.

export const MAX_QUICK_SENDS = 4;

// What a player starts with before saving their own. Player ids aren't known in advance,
// so these go to everyone else in the room (toEveryone) rather than to a recipients list.
export const DEFAULT_QUICK_SENDS = [
    { emoji: '❤️', message: '', recipients: [], toEveryone: true },
    { emoji: '🥶', message: '', recipients: [], toEveryone: true },
    { emoji: '🤬', message: '', recipients: [], toEveryone: true },
    { emoji: '🥷', message: '', recipients: [], toEveryone: true },
];

export function quickSendsKey(roomId) {
    return `quick_sends_${roomId}`;
}

/**
 * The stored value as a list. Anything that isn't one (missing, corrupt) gives the defaults;
 * a saved list is kept, so a player who deleted every combo keeps an empty list. Only the
 * first MAX_QUICK_SENDS are kept, since only those are shown.
 */
export function toQuickSendList(stored) {
    if (Array.isArray(stored)) {
        return stored.slice(0, MAX_QUICK_SENDS);
    }
    return DEFAULT_QUICK_SENDS;
}

/** Ids of the players in `otherPlayers` the combo goes to; players who left are dropped. */
export function quickSendRecipientIds(combo, otherPlayers) {
    if (combo.toEveryone) {
        return otherPlayers.map(player => player.id);
    }

    const recipients = combo.recipients || [];
    return recipients.filter(id => otherPlayers.some(player => player.id === id));
}

/**
 * Puts `entry` first. An older combo with the same emoji and message is replaced, and only
 * the newest MAX_QUICK_SENDS are kept.
 */
export function addQuickSend(list, entry) {
    const others = [];
    for (const combo of list) {
        const isSameCombo = combo.emoji === entry.emoji && combo.message === entry.message;
        if (!isSameCombo) {
            others.push(combo);
        }
    }
    return [entry, ...others].slice(0, MAX_QUICK_SENDS);
}

export function removeQuickSend(list, index) {
    return list.filter((_combo, comboIndex) => comboIndex !== index);
}

export function moveQuickSend(list, fromIndex, toIndex) {
    const updated = [...list];
    const [moved] = updated.splice(fromIndex, 1);
    updated.splice(toIndex, 0, moved);
    return updated;
}

/** Merges `changes` into the combo at `index`. */
export function updateQuickSendAt(list, index, changes) {
    const updated = [];
    for (let comboIndex = 0; comboIndex < list.length; comboIndex += 1) {
        if (comboIndex === index) {
            updated.push({ ...list[comboIndex], ...changes });
        } else {
            updated.push(list[comboIndex]);
        }
    }
    return updated;
}
