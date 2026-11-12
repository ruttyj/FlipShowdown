import React from 'react';

/**
 * Whether to show a player as online. My own presence can lag behind, but if I can see
 * the screen I'm here.
 */
export function isPlayerOnline(player, isMe) {
    return isMe || player.online === true;
}

/** Row opacity for offline players, so the host sees whom to wait for or remove. */
export const OFFLINE_ROW_CLASSES = 'opacity-50';

/** The dot next to a player's name: green while they are online, otherwise grey. */
export function OnlineDot({ isOnline }) {
    const colourClass = isOnline ? 'bg-emerald-500' : 'bg-slate-300';

    return (
        <span
            className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${colourClass}`}
            title={isOnline ? 'Online' : 'Offline'}
        />
    );
}

export default function OfflineBadge() {
    return <span className="text-xs text-slate-500 flex-shrink-0">offline</span>;
}
