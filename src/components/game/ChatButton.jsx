import React, { useEffect, useRef, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { motion } from 'framer-motion';
import { LEFT_STACK_OFF_SCREEN, LEFT_STACK_ON_SCREEN } from '@/lib/floatingStacks';

// A second tap within this long makes a double tap (X79).
export const DOUBLE_TAP_MS = 300;

/**
 * The chat button (X79). One tap calls onTap, but only once DOUBLE_TAP_MS has passed without a
 * second; two taps inside it call onDoubleTap instead, and never onTap. Every tap sends a pulse
 * wave out from the button.
 *
 * @param {{onTap: () => void, onDoubleTap: () => void, isOpen: boolean, isExpanded: boolean}} props
 *   isOpen: the chat dialog is open; isExpanded: the quick sends are showing
 */
export default function ChatButton({ onTap, onDoubleTap, isOpen, isExpanded }) {
    const pendingTapRef = useRef(null);
    // One id per wave still animating. A wave removes itself when its animation ends.
    const [waveIds, setWaveIds] = useState([]);
    const nextWaveIdRef = useRef(0);

    useEffect(() => {
        return () => clearTimeout(pendingTapRef.current);
    }, []);

    const sendWave = () => {
        const waveId = nextWaveIdRef.current;
        nextWaveIdRef.current += 1;
        setWaveIds(previous => [...previous, waveId]);
    };

    const removeWave = (waveId) => {
        setWaveIds(previous => previous.filter(id => id !== waveId));
    };

    const handleClick = () => {
        sendWave();

        if (pendingTapRef.current !== null) {
            clearTimeout(pendingTapRef.current);
            pendingTapRef.current = null;
            onDoubleTap();
            return;
        }

        pendingTapRef.current = setTimeout(() => {
            pendingTapRef.current = null;
            onTap();
        }, DOUBLE_TAP_MS);
    };

    return (
        <motion.button
            aria-label="Chat"
            aria-expanded={isExpanded}
            title="Tap for quick sends, double-tap for chat"
            onClick={handleClick}
            initial={LEFT_STACK_OFF_SCREEN}
            animate={LEFT_STACK_ON_SCREEN}
            exit={LEFT_STACK_OFF_SCREEN}
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.95 }}
            className={`fixed bottom-6 left-6 mb-[env(safe-area-inset-bottom)] z-50 w-14 h-14 rounded-full flex items-center justify-center shadow-lg transition-colors touch-manipulation ${
                isOpen || isExpanded ? 'bg-ui-accent-strong' : 'bg-ui-accent hover:bg-ui-accent-strong'
            }`}
            style={{border: '2px solid black'}}
        >
            {waveIds.map(waveId => (
                <span
                    key={waveId}
                    data-testid="chat-button-pulse"
                    aria-hidden="true"
                    onAnimationEnd={() => removeWave(waveId)}
                    className="pointer-events-none absolute -inset-0.5 rounded-full border-4 border-ui-accent opacity-0 animate-chat-button-pulse motion-reduce:animate-chat-button-fade"
                />
            ))}
            <MessageCircle className="w-6 h-6 text-ui-on-accent" />
        </motion.button>
    );
}
