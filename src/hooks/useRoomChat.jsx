import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { backend } from '@/api/backend';
import { deliverSend, pickEmojiItem, sendFailureMessage } from '@/lib/chatSends';
import { filterIncomingForMute, readChatMuted, writeChatMuted } from '@/lib/chatMute';
import {
    addQuickSend,
    moveQuickSend,
    quickSendRecipientIds,
    quickSendsKey,
    removeQuickSend,
    toQuickSendList,
    updateQuickSendAt,
} from '@/lib/quickSends';
import { readLocalJson, writeLocalJson } from '@/lib/safeStorage';

// The room's chat: sending, quick sends, incoming messages turned into animations, and mute.
// Screens use useRoomChat's result; only the mute button outside the room needs useChatMute.

// --- Mute ------------------------------------------------------------------------

const ChatMuteContext = createContext(null);

/**
 * Shared chat mute state: the button lives in Layout and the messages are handled in useRoomChat.
 * `pulseKey` goes up by one for each muted update that had a message for me (see ChatMuteToggle).
 */
export function ChatMuteProvider({ children }) {
    const [isChatMuted, setIsChatMuted] = useState(readChatMuted);
    const [pulseKey, setPulseKey] = useState(0);

    useEffect(() => {
        writeChatMuted(isChatMuted);
    }, [isChatMuted]);

    const toggleChatMute = useCallback(() => {
        setIsChatMuted(previous => !previous);
    }, []);

    const notifyMutedMessage = useCallback(() => {
        setPulseKey(previous => previous + 1);
    }, []);

    const value = useMemo(() => ({
        isChatMuted,
        toggleChatMute,
        pulseKey,
        notifyMutedMessage,
    }), [isChatMuted, toggleChatMute, pulseKey, notifyMutedMessage]);

    return <ChatMuteContext.Provider value={value}>{children}</ChatMuteContext.Provider>;
}

export const useChatMute = () => {
    const context = useContext(ChatMuteContext);
    if (!context) {
        throw new Error('useChatMute must be used inside <ChatMuteProvider>');
    }
    return context;
};

// --- Quick sends -----------------------------------------------------------------

// Nothing stored reads as null, so toQuickSendList can tell it from a saved empty list.
// Combos past the ones shown are dropped from storage too, so nothing hidden is kept.
function loadQuickSends(roomId) {
    const stored = readLocalJson(quickSendsKey(roomId), null);
    const list = toQuickSendList(stored);
    if (Array.isArray(stored) && stored.length > list.length) {
        writeLocalJson(quickSendsKey(roomId), list);
    }
    return list;
}

/**
 * Up to MAX_QUICK_SENDS saved combos per room, kept in localStorage (defaults until saved).
 * Each change is computed from the list on screen and stored outside the state update, so
 * React re-running an updater can't write twice; a blocked storage keeps the list in memory.
 */
export function useQuickSends(roomId) {
    const [quickSends, setQuickSends] = useState(() => loadQuickSends(roomId));

    // The room hook runs before the room has loaded (roomId ''), so reload once it's known.
    useEffect(() => {
        setQuickSends(loadQuickSends(roomId));
    }, [roomId]);

    const store = (updated) => {
        setQuickSends(updated);
        writeLocalJson(quickSendsKey(roomId), updated);
    };

    // Called for every chat send, so it saves without a toast.
    const saveQuickSend = (emoji, message, recipients) => {
        if (!emoji) {
            return;
        }
        store(addQuickSend(quickSends, { emoji, message: message || '', recipients }));
    };

    const deleteQuickSend = (index) => {
        store(removeQuickSend(quickSends, index));
        toast.success('Quick send removed');
    };

    const reorderQuickSend = (fromIndex, toIndex) => {
        store(moveQuickSend(quickSends, fromIndex, toIndex));
    };

    const updateQuickSend = (index, data) => {
        store(updateQuickSendAt(quickSends, index, data));
        toast.success('Quick send updated!');
    };

    return { quickSends, saveQuickSend, deleteQuickSend, reorderQuickSend, updateQuickSend };
}

// --- Incoming --------------------------------------------------------------------

/**
 * Plays every new chat emoji for everyone in the room, labelled with who sent it to whom
 * (the sender sees their own). Each recipient gets their own ChatMessage record, so
 * recipient_id identifies messages meant for me; only those play full screen with a cue.
 * Messages that were already there when the room first loaded aren't shown. The seen ids
 * belong to one room, so moving to another room starts over instead of replaying that room's
 * history as emoji.
 * While chat is muted (X44) only my own sends play, and a message for me pulses the mute button.
 * Those messages still count as seen, so unmuting doesn't replay them.
 */
function useIncomingChat({ status, roomId, chatMessages, players, myPlayer, isChatMuted, notifyMutedMessage, play, cue }) {
    // { roomId, ids: Set } for the room the ids were collected in, or null.
    const seenRef = useRef(null);

    useEffect(() => {
        if (status !== 'ready' || !roomId) {
            return;
        }

        const isFirstLoadOfRoom = seenRef.current?.roomId !== roomId;
        if (isFirstLoadOfRoom) {
            seenRef.current = { roomId, ids: new Set(chatMessages.map(message => message.id)) };
            return;
        }

        const seenIds = seenRef.current.ids;
        const newMessages = [];
        for (const message of chatMessages) {
            if (seenIds.has(message.id)) {
                continue;
            }
            seenIds.add(message.id);
            newMessages.push(message);
        }

        const { messagesToPlay, shouldPulse } = filterIncomingForMute(newMessages, {
            isMuted: isChatMuted,
            myPlayerId: myPlayer?.id,
        });
        if (shouldPulse) {
            notifyMutedMessage();
        }

        const item = pickEmojiItem(messagesToPlay, players, myPlayer);
        if (!item) {
            return;
        }

        play(item);
        if (item.isForMe) {
            cue('chat', 'New message');
        }
    }, [status, roomId, chatMessages, players, myPlayer, play, cue, isChatMuted, notifyMutedMessage]);
}

// --- Sending ---------------------------------------------------------------------

function chatRecipientsKey(roomId) {
    return `chat_recipients_${roomId}`;
}

function isSameContent(a, b) {
    return a?.emoji === b?.emoji && a?.message === b?.message;
}

/**
 * @param {object} context
 * @param {string|null} context.roomId
 * @param {object|null} context.myPlayer
 * @param {object[]} context.otherPlayers
 * @param {(emoji: string, message: string, recipients: string[]) => void} context.saveQuickSend
 */
function useChatSending({ roomId, myPlayer, otherPlayers, saveQuickSend }) {
    // The emoji and message of a dialog send that reached only some players, until the rest get it.
    const partialSendRef = useRef(null);

    const deliver = async ({ emoji, message, recipientIds }) => {
        const outcome = await deliverSend(
            (body) => backend.entities.ChatMessage.create(body),
            { roomId, senderId: myPlayer.id, emoji, message, recipientIds },
        );
        const failureMessage = sendFailureMessage(outcome, otherPlayers);
        if (failureMessage) {
            toast.error(failureMessage);
        }
        return outcome;
    };

    /**
     * Sends the chat dialog's draft. Anything that reached someone is remembered as a quick send, with
     * everyone it was meant for, so a retry to the players it missed doesn't narrow that (X37, X60).
     *
     * @param {{emoji: string, message: string, recipientIds: string[]}} draft
     * @returns {Promise<string[]>} the players it didn't reach, whom a retry should go to
     */
    const sendDraft = async (draft) => {
        const { sentIds, failedIds } = await deliver(draft);
        const isRetry = isSameContent(partialSendRef.current, draft);

        if (sentIds.length > 0 && !isRetry) {
            writeLocalJson(chatRecipientsKey(roomId), draft.recipientIds);
            // Every sent combo becomes a quick send, like a chat history to replay from.
            saveQuickSend(draft.emoji, draft.message, draft.recipientIds);
        }

        const isStillPartial = failedIds.length > 0 && (sentIds.length > 0 || isRetry);
        partialSendRef.current = isStillPartial ? { emoji: draft.emoji, message: draft.message } : null;
        return failedIds;
    };

    /** Replays a saved combo. There's no draft to retry from, so a miss is only reported (X60). */
    const sendQuickSend = async (combo) => {
        const hasRecipients = combo.toEveryone || combo.recipients?.length > 0;
        if (!hasRecipients) {
            return;
        }

        const recipientIds = quickSendRecipientIds(combo, otherPlayers);
        if (recipientIds.length === 0) {
            toast.error('No valid recipients — they may have left');
            return;
        }
        await deliver({ emoji: combo.emoji, message: combo.message, recipientIds });
    };

    /** Who the dialog starts with: the last players chosen who are still here, else the first player. */
    const initialRecipientIds = () => {
        const saved = readLocalJson(chatRecipientsKey(roomId), []);
        const savedIds = Array.isArray(saved) ? saved : [];
        const validIds = savedIds.filter(id => otherPlayers.some(player => player.id === id));
        if (validIds.length > 0) {
            return validIds;
        }
        return otherPlayers.slice(0, 1).map(player => player.id);
    };

    const rememberRecipients = (recipientIds) => {
        writeLocalJson(chatRecipientsKey(roomId), recipientIds);
    };

    return { sendDraft, sendQuickSend, initialRecipientIds, rememberRecipients };
}

// --- The room's chat -------------------------------------------------------------

/**
 * @param {object} context
 * @param {string} context.status  useRoomData's status; messages are only read once it is 'ready'
 * @param {string|null} context.roomId
 * @param {object[]} context.chatMessages
 * @param {object[]} context.players
 * @param {object|null} context.myPlayer
 * @param {(kind: string, title: string) => void} context.cue  from useAttentionCues
 */
export function useRoomChat({ status, roomId, chatMessages, players, myPlayer, cue }) {
    const { isChatMuted, notifyMutedMessage } = useChatMute();
    const [isOpen, setIsOpen] = useState(false);
    // The quick sends fold into the chat button until a tap opens them (X79).
    const [quickSendsOpen, setQuickSendsOpen] = useState(false);
    // The newest chat emoji to animate (shape in lib/emojiQueue.js), or null.
    const [playing, setPlaying] = useState(null);
    const { quickSends, saveQuickSend, deleteQuickSend, reorderQuickSend, updateQuickSend } = useQuickSends(roomId || '');
    const otherPlayers = players.filter(player => player.id !== myPlayer?.id);

    // Muting hides the chat button (X44), so an open dialog closes with it. It also closes what's
    // playing; EmojiAnimation holds the queue, so that clears too.
    useEffect(() => {
        if (isChatMuted) {
            setIsOpen(false);
            setQuickSendsOpen(false);
            setPlaying(null);
        }
    }, [isChatMuted]);

    useIncomingChat({
        status,
        roomId,
        chatMessages,
        players,
        myPlayer,
        isChatMuted,
        notifyMutedMessage,
        play: setPlaying,
        cue,
    });

    const sending = useChatSending({ roomId, myPlayer, otherPlayers, saveQuickSend });

    const openDialog = () => {
        setQuickSendsOpen(false);
        setIsOpen(true);
    };

    // One tap on the chat button (X79): closes an open dialog, or else opens or folds the quick
    // sends. With none saved there is nothing to unfold, so it opens the dialog instead.
    const tapChatButton = () => {
        if (isOpen) {
            setIsOpen(false);
            return;
        }

        if (quickSends.length === 0) {
            openDialog();
            return;
        }

        setQuickSendsOpen(previous => !previous);
    };

    // A double tap (X79) goes straight to the dialog and leaves the quick sends folded, or closes
    // the dialog when it's already open.
    const doubleTapChatButton = () => {
        if (isOpen) {
            setIsOpen(false);
            return;
        }

        openDialog();
    };

    return {
        isMuted: isChatMuted,
        isOpen,
        toggleOpen: () => setIsOpen(previous => !previous),
        close: () => setIsOpen(false),
        quickSendsOpen,
        closeQuickSends: () => setQuickSendsOpen(false),
        tapChatButton,
        doubleTapChatButton,
        otherPlayers,
        quickSends,
        deleteQuickSend,
        reorderQuickSend,
        updateQuickSend,
        ...sending,
        playing,
        dismissPlaying: () => setPlaying(null),
    };
}
