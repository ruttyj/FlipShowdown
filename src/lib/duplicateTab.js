// Message handling for detecting the same room open in two tabs of one browser.
// Messages: { type: 'hello' | 'present' | 'bye', roomId, tabId }.
// A new tab says 'hello'; existing tabs of that room answer 'present'.
// Both sides then know there is a duplicate. A tab that closes (pagehide) or leaves the
// room says 'bye', so the others stop warning once it's gone.

export const DUPLICATE_TAB_CHANNEL = 'flip7';

export function helloMessage(roomId, tabId) {
    return { type: 'hello', roomId, tabId };
}

export function presentMessage(roomId, tabId) {
    return { type: 'present', roomId, tabId };
}

export function byeMessage(roomId, tabId) {
    return { type: 'bye', roomId, tabId };
}

/** True for a well-formed message about this room from another tab. */
function isFromOtherTab(message, roomId, tabId) {
    if (!message || typeof message !== 'object') {
        return false;
    }
    return message.roomId === roomId && message.tabId !== tabId;
}

// Returns { isDuplicate, reply } where reply is a message to send back, or null.
export function handleTabMessage(message, roomId, tabId) {
    const ignored = { isDuplicate: false, reply: null };
    if (!isFromOtherTab(message, roomId, tabId)) {
        return ignored;
    }
    if (message.type === 'hello') {
        return { isDuplicate: true, reply: presentMessage(roomId, tabId) };
    }
    if (message.type === 'present') {
        return { isDuplicate: true, reply: null };
    }
    return ignored;
}

/**
 * The ids of the other tabs open on this room after `message`: 'hello' and 'present' add the
 * sender, 'bye' removes it. Returns the same array when nothing changed.
 *
 * @param {string[]} otherTabIds
 */
export function updateOtherTabs(otherTabIds, message, roomId, tabId) {
    if (!isFromOtherTab(message, roomId, tabId)) {
        return otherTabIds;
    }

    const isKnown = otherTabIds.includes(message.tabId);
    const isArrival = message.type === 'hello' || message.type === 'present';
    if (isArrival && !isKnown) {
        return [...otherTabIds, message.tabId];
    }
    if (message.type === 'bye' && isKnown) {
        return otherTabIds.filter((id) => id !== message.tabId);
    }
    return otherTabIds;
}
