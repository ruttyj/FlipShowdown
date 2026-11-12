import React, { useEffect } from 'react';
import { Toaster } from "sonner";
import { SoundProvider, useSound } from '@/components/useSound';
import { ChatMuteProvider, useChatMute } from '@/hooks/useRoomChat';
import { useKeepScreenOn } from '@/hooks/useKeepScreenOn';
import ChatMuteToggle from '@/components/game/ChatMuteToggle';
import FullscreenToggle from '@/components/game/FullscreenToggle';
import SoundToggle from '@/components/game/SoundToggle';
import QRCodeToggle from '@/components/game/QRCodeToggle';
import ConnectionBanner from '@/components/ConnectionBanner';
import { useLocation } from 'react-router-dom';
import { installKeyboardScrollReset } from '@/lib/keyboardScrollReset';
import { readRoomCode } from '@/lib/roomUrl';

// The full-size chat emoji (X35) covers the whole screen, so a tap anywhere dismisses it. The
// toggles rise above it while it shows, so tapping mute reaches the button (X44). Reading the
// overlay from the DOM follows EmojiAnimation's own queue, which Layout can't see. They stay under
// dialogs (z-50) the rest of the time.
const TOGGLES_ABOVE_FULL_EMOJI = '[body:has([data-full-emoji])_&]:z-[201]';

export default function Layout({ children }) {
    return (
        <SoundProvider>
            <ChatMuteProvider>
                <LayoutContent>{children}</LayoutContent>
            </ChatMuteProvider>
        </SoundProvider>
    );
}

function LayoutContent({ children }) {
    const { isMuted, toggleMute } = useSound();
    const { isChatMuted, toggleChatMute, pulseKey } = useChatMute();
    const location = useLocation();
    useKeepScreenOn();

    const roomCode = readRoomCode(location.pathname);

    useEffect(() => {
        const metaTag = document.querySelector('meta[name="viewport"]');
        if (metaTag) {
            metaTag.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no');
        }
    }, []);

    useEffect(() => installKeyboardScrollReset(window), []);

    const isGameScreen = Boolean(roomCode);

    return (
        <div className="h-[100dvh] bg-slate-900 overflow-hidden flex flex-col">
            <ConnectionBanner />
            <Toaster position="top-center" richColors />
            <div className="flex-1 overflow-y-auto overflow-x-hidden">
                {children}
            </div>
            <FullscreenToggle />
            <div className={`fixed bottom-4 right-4 mb-[env(safe-area-inset-bottom)] z-40 ${TOGGLES_ABOVE_FULL_EMOJI} flex flex-col gap-2`}>
                {isGameScreen && !location.search.includes('waiting') && (
                    <QRCodeToggle roomCode={roomCode} />
                )}
                {isGameScreen && (
                    <ChatMuteToggle isMuted={isChatMuted} onToggle={toggleChatMute} pulseKey={pulseKey} />
                )}
                <SoundToggle isMuted={isMuted} onToggle={toggleMute} />
            </div>
        </div>
    );
}