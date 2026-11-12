import React, { useState } from 'react';
import { MessageCircle, MessageCircleOff } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Mutes chat on this device (X44). While muted, a message for me pulses a soft ring, meant to be
 * noticed only if you glance at it, so it has no sound, count, scaling or live region. The ring
 * is removed when its animation ends, or on a tap.
 *
 * @param {{isMuted: boolean, onToggle: () => void, pulseKey: number}} props
 *   pulseKey changes for each new pulse; the ring is keyed on it, so a new one restarts the animation.
 */
export default function ChatMuteToggle({ isMuted, onToggle, pulseKey }) {
    // The pulse already dealt with. It starts at the current key so that coming back to a room,
    // which remounts this button, doesn't replay an old pulse.
    const [finishedPulseKey, setFinishedPulseKey] = useState(pulseKey);
    const isPulsing = pulseKey !== finishedPulseKey;
    const label = isMuted ? 'Unmute chat' : 'Mute chat';

    const handleClick = () => {
        setFinishedPulseKey(pulseKey);
        onToggle();
    };

    return (
        <div className="relative">
            <Button
                onClick={handleClick}
                variant="outline"
                size="icon"
                className="h-10 w-10 rounded-full"
                aria-label={label}
                title={label}
            >
                {isMuted ? (
                    <MessageCircleOff className="w-5 h-5 text-slate-500" />
                ) : (
                    <MessageCircle className="w-5 h-5 text-slate-600" />
                )}
            </Button>
            {isPulsing && (
                <span
                    key={pulseKey}
                    data-testid="chat-mute-pulse"
                    aria-hidden="true"
                    onAnimationEnd={() => setFinishedPulseKey(pulseKey)}
                    className="pointer-events-none absolute -inset-1 rounded-full opacity-0 ring-2 ring-[color:var(--mute-pulse-color)] shadow-[0_0_8px_2px_var(--mute-pulse-color)] animate-chat-mute-pulse motion-reduce:animate-chat-mute-fade"
                />
            )}
        </div>
    );
}
