import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { LEFT_STACK_OFF_SCREEN, LEFT_STACK_ON_SCREEN } from '@/lib/floatingStacks';
import { quickSendRecipientIds } from '@/lib/quickSends';

// A quick send folded into the chat button, and shown above it.
const FOLDED = { opacity: 0, scale: 0.6, y: 24 };
const UNFOLDED = { opacity: 1, scale: 1, y: 0 };
const UNFOLD_TWEEN = { duration: 0.22, ease: [0.22, 1, 0.36, 1] };
const FOLD_TWEEN = { duration: 0.16, ease: [0.4, 0, 1, 1] };
// Between one quick send and the next.
const STAGGER_S = 0.035;

/**
 * The quick sends, stacked above the chat button. They fold into it while not expanded, and a
 * send folds them away again (X79).
 *
 * @param {{chat: object, isExpanded: boolean, onSend: () => void}} props  chat is useRoomChat's result
 */
export default function QuickSendBar({ chat, isExpanded, onSend }) {
    const { quickSends, otherPlayers } = chat;
    const [sending, setSending] = useState(null);

    const handleQuickSend = async (combo, index) => {
        if (sending !== null) {
            return;
        }

        onSend();
        setSending(index);
        await chat.sendQuickSend(combo);
        setSending(null);
    };

    const getRecipientLabel = (combo) => {
        if (combo.toEveryone) {
            return 'All';
        }

        if (!combo.recipients?.length) {
            return '';
        }

        const validRecipients = quickSendRecipientIds(combo, otherPlayers);
        const isEveryone = validRecipients.length === otherPlayers.length && otherPlayers.length > 0;
        if (isEveryone) {
            return 'All';
        }

        return validRecipients.map(id => {
            const p = otherPlayers.find(p => p.id === id);
            if (!p) {
                return '?';
            }
            const parts = p.name.trim().split(/\s+/);
            return parts.map(w => w[0]?.toUpperCase()).join('');
        }).join(', ');
    };

    if (!quickSends.length) {
        return null;
    }

    return (
        <motion.div
            initial={LEFT_STACK_OFF_SCREEN}
            animate={LEFT_STACK_ON_SCREEN}
            exit={LEFT_STACK_OFF_SCREEN}
            className="fixed bottom-24 left-6 mb-[env(safe-area-inset-bottom)] z-50 flex flex-col-reverse gap-3"
        >
            <AnimatePresence>
                {isExpanded && quickSends.map((combo, i) => (
                    <motion.button
                        key={`${combo.emoji}-${combo.message}-${i}`}
                        // They rise out of the chat button below them, nearest first, and sink back
                        // into it, farthest first. Only colours have a CSS transition: one on transform
                        // or opacity would re-tween each frame framer-motion sets, and flicker.
                        initial={FOLDED}
                        animate={{ ...UNFOLDED, transition: { ...UNFOLD_TWEEN, delay: i * STAGGER_S } }}
                        exit={{ ...FOLDED, transition: { ...FOLD_TWEEN, delay: (quickSends.length - 1 - i) * STAGGER_S } }}
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.9 }}
                        onClick={() => handleQuickSend(combo, i)}
                        disabled={sending !== null}
                        title={combo.message ? `${combo.emoji} "${combo.message}"` : combo.emoji}
                        style={{ transformOrigin: '50% 100%' }}
                        className={`relative w-12 h-12 rounded-full flex items-center justify-center text-2xl shadow-lg border-2 transition-colors ${
                            sending === i
                                ? 'bg-ui-accent-border border-ui-accent-bright opacity-70'
                                : 'bg-white border-ui-accent-border-strong hover:border-ui-accent-vivid hover:bg-ui-accent-soft'
                        }`}
                    >
                        <motion.span
                            animate={sending === i ? { rotate: [0, -10, 10, -10, 0] } : {}}
                            transition={{ duration: 0.4 }}
                        >
                            {combo.emoji}
                        </motion.span>
                        <span className="absolute -top-1.5 -right-1.5 bg-ui-accent text-ui-on-accent text-[8px] font-bold leading-none px-1 py-0.5 rounded-full whitespace-nowrap max-w-[60px] truncate">
                            {getRecipientLabel(combo)}
                        </span>
                    </motion.button>
                ))}
            </AnimatePresence>
        </motion.div>
    );
}