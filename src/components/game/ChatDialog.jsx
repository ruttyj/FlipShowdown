import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { X, Send, Settings } from 'lucide-react';
import QuickSendsManager from './QuickSendsManager';
import EmojiPicker from 'emoji-picker-react';

/** @param {{chat: object}} props  chat is useRoomChat's result */
export default function ChatDialog({ chat }) {
    const { isOpen: open, otherPlayers, quickSends } = chat;
    const [selectedRecipients, setSelectedRecipients] = useState([]);
    const [message, setMessage] = useState('');
    const [selectedEmoji, setSelectedEmoji] = useState(null);
    const [isSmallScreen, setIsSmallScreen] = useState(window.innerWidth < 768);
    const [showQuickManager, setShowQuickManager] = useState(false);

    // otherPlayers is a new array every render; the joined ids are a stable key, so the
    // saved selection is only re-applied when the dialog opens or the player set changes.
    const otherPlayerIds = otherPlayers.map(p => p.id).join(',');
    const chatRef = useRef(chat);
    chatRef.current = chat;

    useEffect(() => {
        if (!open || otherPlayerIds === '') {
            return;
        }
        setSelectedRecipients(chatRef.current.initialRecipientIds());
    }, [open, otherPlayerIds]);

    useEffect(() => {
        const handleResize = () => setIsSmallScreen(window.innerWidth < 768);
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    const toggleRecipient = (playerId) => {
        setSelectedRecipients(prev => {
            const newSelection = prev.includes(playerId)
                ? prev.filter(id => id !== playerId)
                : [...prev, playerId];
            chat.rememberRecipients(newSelection);
            return newSelection;
        });
    };

    const handleSendEmoji = async () => {
        if (!selectedEmoji || selectedRecipients.length === 0) return;

        const failedIds = await chat.sendDraft({ emoji: selectedEmoji, message, recipientIds: selectedRecipients });
        if (failedIds.length > 0) {
            // The draft stays, aimed at whoever it missed, so sending again can't repeat it to the rest (X60).
            setSelectedRecipients(failedIds);
            return;
        }

        setSelectedEmoji(null);
        setMessage('');
        chat.close();
    };

    if (!open) return null;

    const contentClasses = isSmallScreen
        ? 'fixed inset-0 z-[50] w-full h-full flex flex-col'
        : 'fixed bottom-24 left-6 z-[50] w-96 h-[600px] flex flex-col';

    return (
        <>
            <motion.div
                initial={{ opacity: 0, scale: isSmallScreen ? 1 : 0.95, y: isSmallScreen ? 100 : 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: isSmallScreen ? 1 : 0.95, y: isSmallScreen ? 100 : 20 }}
                className={`${contentClasses} bg-ui-accent shadow-2xl overflow-hidden ${isSmallScreen ? '' : 'rounded-lg'}`}
            >
                {/* Header */}
                <div className={`bg-ui-accent text-ui-on-accent px-4 py-3 flex items-center justify-between flex-shrink-0 ${isSmallScreen ? '' : 'rounded-t-lg'}`}>
                    <span className="text-lg font-semibold">Chat</span>
                    <div className="flex items-center gap-1">
                        {quickSends.length > 0 && (
                            <button
                                onClick={() => setShowQuickManager(true)}
                                className="hover:bg-ui-accent-strong p-1 rounded transition-colors"
                                title="Manage quick sends"
                            >
                                <Settings className="w-5 h-5" />
                            </button>
                        )}
                        <button
                            onClick={chat.close}
                            aria-label="Close chat"
                            className="hover:bg-ui-accent-strong p-1 rounded transition-colors"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                </div>

                {/* Emoji Picker */}
                <div className="flex-1 bg-white overflow-hidden">
                    <EmojiPicker
                        onEmojiClick={(emojiData) => setSelectedEmoji(emojiData.emoji)}
                        autoFocusSearch={false}
                        width="100%"
                        height="100%"
                        searchPlaceholder="Search emojis..."
                        previewConfig={{ showPreview: false }}
                    />
                </div>

                {/* Recipients */}
                <div className="px-4 py-3 border-t border-gray-200 bg-white flex flex-wrap gap-2 flex-shrink-0">
                    {otherPlayers.map(player => (
                        <button
                            key={player.id}
                            onClick={() => toggleRecipient(player.id)}
                            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                                selectedRecipients.includes(player.id)
                                    ? 'bg-ui-accent text-ui-on-accent'
                                    : 'bg-gray-200 text-gray-800 hover:bg-gray-300'
                            }`}
                        >
                            {player.name}
                        </button>
                    ))}
                </div>

                {/* Message Input */}
                <div className={`px-4 py-3 border-t border-gray-200 bg-white flex gap-2 items-center flex-shrink-0 ${isSmallScreen ? '' : 'rounded-b-lg'}`}>
                    <input
                        type="text"
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        placeholder="Type a message..."
                        className="min-w-0 flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-ui-accent-vivid"
                    />
                    <div className="flex items-center gap-1 flex-shrink-0">
                        {selectedEmoji && (
                            <div className="flex items-center gap-1 px-1 py-1 bg-ui-accent-soft border border-ui-accent-border rounded-lg">
                                <span className="text-2xl">{selectedEmoji}</span>
                                <button onClick={() => setSelectedEmoji(null)} aria-label="Clear emoji" className="text-ui-accent hover:text-ui-accent-deep">
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                        )}
                        <button
                            onClick={handleSendEmoji}
                            aria-label="Send"
                            disabled={!selectedEmoji || selectedRecipients.length === 0}
                            className="bg-ui-accent hover:bg-ui-accent-strong disabled:opacity-50 disabled:cursor-not-allowed text-ui-on-accent p-2.5 rounded-lg transition-colors"
                        >
                            <Send className="w-4 h-4" />
                        </button>
                    </div>
                </div>

                {/* Quick Sends Manager — slides over */}
                {showQuickManager && (
                    <QuickSendsManager
                        quickSends={quickSends}
                        otherPlayers={otherPlayers}
                        onBack={() => setShowQuickManager(false)}
                        onDelete={chat.deleteQuickSend}
                        onUpdate={chat.updateQuickSend}
                        onReorder={chat.reorderQuickSend}
                    />
                )}
            </motion.div>
        </>
    );
}