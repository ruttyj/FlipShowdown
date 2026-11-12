import React from 'react';

/** @typedef {import('../shared/launcherBridge').RoomStats} RoomStats */

/**
 * Players online and rooms in play, as two tiles (X66). The numbers are plain text, not a live
 * region: they can change every second, and announcing each change would drown out the hosting
 * status sentence. Dimmed while `isStale`.
 * @param {{ stats: RoomStats, isStale: boolean }} props
 */
export default function LiveCounts({ stats, isStale }) {
    return (
        <div data-stale={isStale} className="launcher-stats grid grid-cols-2 gap-2">
            <LiveCount tone="players" value={stats.playersOnline} one="Player online" many="Players online" hasDot />
            <LiveCount tone="rooms" value={stats.roomsLive} one="Room in play" many="Rooms in play" />
        </div>
    );
}

/**
 * One centred tile: the number, then its label. The label is written in sentence case and shown
 * in capitals by CSS, so screen readers say words, not letters.
 * @param {{ tone: 'players' | 'rooms', value: number, one: string, many: string, hasDot?: boolean }} props
 */
function LiveCount({ tone, value, one, many, hasDot = false }) {
    const label = value === 1 ? one : many;

    return (
        <p data-tone={tone} data-zero={value === 0} className="launcher-stat">
            <span className="launcher-stat-number">{value}</span>
            <span className="launcher-stat-label">
                {hasDot && <span aria-hidden="true" className="launcher-chip-dot" />}
                {label}
            </span>
        </p>
    );
}
