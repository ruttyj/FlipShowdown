import { readLocalJson, writeLocalJson } from './safeStorage.js';

const CHAT_MUTE_KEY = 'flip7_chat_muted';

// --- Preference ------------------------------------------------------------------

/** Per device, so it carries across rooms and rejoins. Unmuted unless explicitly muted (X44). */
export function readChatMuted() {
    return readLocalJson(CHAT_MUTE_KEY, false) === true;
}

export function writeChatMuted(isMuted) {
    writeLocalJson(CHAT_MUTE_KEY, isMuted);
}

// --- Incoming messages -----------------------------------------------------------

/**
 * Decides what a batch of new chat messages does on this device (X44). Muting only affects
 * receiving, so my own sends still play as my confirmation. Each recipient of a send has their
 * own ChatMessage, so the parts of one send addressed to other players are dropped with it.
 *
 * @param {{sender_id: string, recipient_id: string}[]} newMessages
 * @param {{isMuted: boolean, myPlayerId: (string|undefined)}} options
 * @returns {{messagesToPlay: object[], shouldPulse: boolean}} shouldPulse: a message to me was held back
 */
export function filterIncomingForMute(newMessages, { isMuted, myPlayerId }) {
    if (!isMuted) {
        return { messagesToPlay: newMessages, shouldPulse: false };
    }

    const messagesToPlay = [];
    let shouldPulse = false;
    for (const message of newMessages) {
        if (message.sender_id === myPlayerId) {
            messagesToPlay.push(message);
            continue;
        }
        if (message.recipient_id === myPlayerId) {
            shouldPulse = true;
        }
    }
    return { messagesToPlay, shouldPulse };
}
