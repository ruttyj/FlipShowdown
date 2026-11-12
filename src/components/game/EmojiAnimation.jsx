import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import {
    EMPTY_EMOJI_QUEUE,
    advanceEmojiQueue,
    emojiCaption,
    enqueueEmoji,
    isSameEmojiItem,
} from '@/lib/emojiQueue';

// How long the small version (a message between other players) stays before fading out.
export const SMALL_EMOJI_DURATION_MS = 3500;

// How long the recipient's full-screen version dances before it goes away on its own (X35):
// the entrance plus about two wiggles.
export const FULL_EMOJI_DURATION_MS = 3000;

// The recipient's version: full screen, plays for FULL_EMOJI_DURATION_MS unless dismissed sooner.
// Sizes use vmin so the emoji and text grow with the screen instead of looking tiny on a tablet.
// The overlay stays mounted from one item to the next; only the content inside swaps (X36).
function FullEmoji({ current, pendingCount, onDismiss, onDismissAll }) {
    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onDismiss}
            onKeyDown={(event) => {
                if (event.key === 'Escape') {
                    onDismiss();
                }
            }}
            role="dialog"
            aria-modal="true"
            aria-label={`Message from ${current.sender}`}
            data-full-emoji=""
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm cursor-pointer"
        >
            {/* The whole overlay dismisses on tap; this gives keyboard and screen reader
                users a named control for it. A click here bubbles to the overlay. */}
            <button
                type="button"
                autoFocus
                aria-label="Dismiss message"
                className="absolute top-4 right-4 rounded-full p-2 md:p-3 text-white/80 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
                <X className="w-6 h-6 md:w-9 md:h-9" aria-hidden="true" />
            </button>
            <AnimatePresence mode="wait">
                <motion.div
                    key={current.sequence}
                    initial={{ scale: 0, rotate: -180 }}
                    animate={{ scale: 1, rotate: 0 }}
                    exit={{ scale: 0, rotate: 180 }}
                    transition={{ type: "spring", duration: 0.5 }}
                    className="flex flex-col items-center gap-[clamp(1rem,3vmin,2.5rem)]"
                >
                    <motion.div
                        animate={{
                            scale: [1, 1.2, 1],
                            rotate: [0, 10, -10, 0]
                        }}
                        transition={{
                            duration: 1,
                            repeat: Infinity,
                            repeatDelay: 0.5
                        }}
                        className="text-[clamp(150px,45vmin,480px)] leading-none drop-shadow-2xl"
                    >
                        {current.emoji}
                    </motion.div>
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.3 }}
                        className="text-white text-[clamp(1.5rem,4.5vmin,3.5rem)] font-bold drop-shadow-lg text-center px-4 space-y-[0.4em]"
                    >
                        {current.message && (
                            <p>{current.message}</p>
                        )}
                        <p className="text-[0.75em] font-normal text-white/90">{emojiCaption(current)}</p>
                        {pendingCount > 0 && (
                            <>
                                <p className="text-[0.6em] font-normal text-white/70">
                                    {pendingCount} more
                                </p>
                                <div className="pt-2">
                                    {/* Clears this item and everything waiting (X33). Stops the click so the
                                        overlay doesn't also count it as a single dismiss. */}
                                    <button
                                        type="button"
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            onDismissAll();
                                        }}
                                        className="min-h-[44px] md:min-h-[56px] rounded-full border border-white/70 px-[1.2em] text-[0.65em] font-semibold text-white hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                                    >
                                        Dismiss all
                                    </button>
                                </div>
                            </>
                        )}
                    </motion.div>
                </motion.div>
            </AnimatePresence>
        </motion.div>
    );
}

// Everyone else's version (the sender's too): a small card near the top that fades out on its
// own. Only the card takes taps, so the game underneath stays usable while it plays.
function SmallEmoji({ current, onDismiss }) {
    return (
        <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            role="status"
            aria-label={`${emojiCaption(current)}: ${current.emoji}`}
            className="fixed inset-x-0 top-16 z-[200] flex justify-center px-4 pointer-events-none"
        >
            <button
                type="button"
                onClick={onDismiss}
                className="pointer-events-auto flex items-center gap-3 max-w-xs rounded-2xl bg-slate-900/80 px-4 py-2 text-left text-white shadow-xl backdrop-blur-sm"
            >
                <motion.span
                    initial={{ scale: 0, rotate: -90 }}
                    animate={{ scale: [0, 1.3, 1], rotate: 0 }}
                    transition={{ duration: 0.5 }}
                    className="text-5xl"
                    aria-hidden="true"
                >
                    {current.emoji}
                </motion.span>
                <span className="min-w-0">
                    {current.message && (
                        <span className="block truncate text-sm font-semibold">{current.message}</span>
                    )}
                    <span className="block truncate text-xs text-white/80">{emojiCaption(current)}</span>
                </span>
            </button>
        </motion.div>
    );
}

// Shows chat emojis one after another. The parent keeps passing the latest message as
// `item` (see the shape in lib/emojiQueue.js); each new message is queued behind the one on
// screen instead of replacing it. Messages for me play full screen for FULL_EMOJI_DURATION_MS;
// the rest play small and fade out after SMALL_EMOJI_DURATION_MS. Either can be dismissed sooner. A full-size message with others
// waiting also offers "Dismiss all", which clears the whole queue.
// `onClose` is called once the whole queue has been dismissed.
export default function EmojiAnimation({ item, onClose }) {
    const [queue, setQueue] = useState(() => (
        item ? enqueueEmoji(EMPTY_EMOJI_QUEUE, { ...item, sequence: 0 }) : EMPTY_EMOJI_QUEUE
    ));
    const lastSeenRef = useRef(item || null);
    const sequenceRef = useRef(0);
    // The sequence of the item "Dismiss all" last cleared, so a double tap clears only once.
    const dismissedAllSequenceRef = useRef(null);

    // Adjust state during render when the props carry a message we haven't queued yet.
    if (item && !isSameEmojiItem(lastSeenRef.current, item)) {
        lastSeenRef.current = item;
        sequenceRef.current += 1;
        setQueue(enqueueEmoji(queue, { ...item, sequence: sequenceRef.current }));
    }

    const handleDismiss = () => {
        const next = advanceEmojiQueue(queue);
        setQueue(next);
        if (next.current === null) {
            lastSeenRef.current = null;
            onClose();
        }
    };

    // Clears the item on screen and everything waiting behind it (X33). A second tap can
    // reach this closure before the first one's update renders, so it remembers which item
    // it cleared and does nothing the second time. Sequences only grow, so this never blocks
    // a later item.
    const handleDismissAll = () => {
        const sequence = queue.current?.sequence;
        if (dismissedAllSequenceRef.current === sequence) {
            return;
        }

        dismissedAllSequenceRef.current = sequence;
        setQueue(EMPTY_EMOJI_QUEUE);
        lastSeenRef.current = null;
        onClose();
    };

    // The fade-out timer outlives renders, so it calls the latest handleDismiss through a ref
    // instead of one that closed over an old queue.
    const dismissRef = useRef(handleDismiss);
    useEffect(() => {
        dismissRef.current = handleDismiss;
    });

    const current = queue.current;
    const currentSequence = current?.sequence;
    const isSmall = Boolean(current) && !current.isForMe;
    useEffect(() => {
        if (currentSequence === undefined) {
            return undefined;
        }
        const duration = isSmall ? SMALL_EMOJI_DURATION_MS : FULL_EMOJI_DURATION_MS;
        const timer = setTimeout(() => dismissRef.current(), duration);
        return () => clearTimeout(timer);
    }, [currentSequence, isSmall]);

    if (!current) {
        return null;
    }

    return (
        <AnimatePresence mode="wait">
            {isSmall ? (
                <SmallEmoji key={current.sequence} current={current} onDismiss={handleDismiss} />
            ) : (
                <FullEmoji key="full" current={current} pendingCount={queue.pending.length} onDismiss={handleDismiss} onDismissAll={handleDismissAll} />
            )}
        </AnimatePresence>
    );
}
