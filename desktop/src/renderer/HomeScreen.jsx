import React from 'react';
import { Button } from '@/components/ui/button';
import FailurePanel from './FailurePanel.jsx';
import GameLinkPanel from './GameLinkPanel.jsx';
import { describeLiveStats, isKeptAwake, isSessionRunning } from './hostingStatus.js';
import { useOnBattery, useRoomStats } from './launcherHooks.js';
import LiveAnnouncement from './LiveAnnouncement.jsx';
import LiveCounts from './LiveCounts.jsx';
import RoomsPanel from './RoomsPanel.jsx';
import StatusChips from './StatusChips.jsx';

const LINK_CHANGED_TEXT = 'The game link changed. Everyone needs to scan the new QR code.';
const BATTERY_WARNING_TEXT = 'This computer is on battery. Plug it in: hosting keeps it awake and drains the battery.';
const NOBODY_YET_TEXT = "Nobody's joined yet. Share the QR code below.";
// keepAwake blocks system sleep while hosting (decision 6), not the lid or the screen turning off.
const AWAKE_HINT_TEXT = 'Flip Showdown keeps this computer awake while hosting. Keep the lid open (closing it still sleeps the laptop) and plug it in.';
const IDLE_HINT_TEXT = 'Keep the lid open and the laptop plugged in while people play.';
// The service terms the game link relies on (X69). `npm run share` and the README say the same.
const TUNNEL_NOTICE_TEXT = "Your game link uses a free Cloudflare Quick Tunnel. It's meant for casual use, has no uptime guarantee, and Cloudflare's terms apply.";
const START_BUTTON_CLASSES = 'h-11 rounded-xl bg-ui-start text-ui-on-start font-bold hover:bg-ui-start-hover';
const STOP_BUTTON_CLASSES = 'h-11 rounded-xl font-bold';

/** @typedef {import('../shared/launcherBridge').LauncherBridge} LauncherBridge */
/** @typedef {ReturnType<typeof import('./useHostingSession.js').useHostingSession>} HostingSession */

/**
 * Light panels, top to bottom (X66): hosting (Start/Stop, the status chips, the live counts and
 * any warning), the game link (the QR code and link players join with, or a placeholder until
 * there is one), the rooms in play, then the power hint.
 * @param {{ launcher: LauncherBridge, hosting: HostingSession }} props
 */
export default function HomeScreen({ launcher, hosting }) {
    const { snapshot } = hosting;
    const roomStats = useRoomStats(launcher);
    if (!snapshot) {
        return <p className="text-sm text-indigo-100/70">Loading…</p>;
    }

    const live = describeLiveStats(snapshot.status);
    const counts = live.showsCounts ? roomStats : null;
    const rooms = live.showsRooms ? roomStats?.rooms ?? null : null;
    // Only once the QR code is up, which is what the line points at.
    const isNobodyYet = snapshot.status === 'hosting'
        && counts !== null
        && counts.playersOnline === 0
        && counts.roomsLive === 0;

    return (
        <div className="flex flex-col gap-3">
            <section aria-label="Hosting" className="launcher-glass flex flex-col gap-3 p-4">
                <p aria-hidden="true" className="launcher-eyebrow">Hosting</p>
                <StatusChips snapshot={snapshot} />
                {counts && <LiveCounts stats={counts} isStale={live.isStale} />}
                {isNobodyYet && <p className="text-center text-sm text-slate-500">{NOBODY_YET_TEXT}</p>}
                <HostingButton status={snapshot.status} onStart={hosting.start} onStop={hosting.stop} />
                <p className="text-xs text-slate-500">{TUNNEL_NOTICE_TEXT}</p>
                {hosting.actionError && <p role="alert" className="text-sm text-destructive">{hosting.actionError}</p>}

                <LiveAnnouncement text={hosting.urlChange ? LINK_CHANGED_TEXT : ''} testId="link-changed-announcement" />
                {hosting.urlChange && <UrlChangedBanner onDismiss={hosting.dismissUrlChange} />}
                {snapshot.status === 'failed' && <FailurePanel snapshot={snapshot} onRetry={hosting.retry} onDismiss={hosting.stop} />}
            </section>

            {/* Keyed by the link so a "Link copied." or error about an old link doesn't carry over. */}
            {snapshot.url && <GameLinkPanel key={snapshot.url} launcher={launcher} url={snapshot.url} />}
            {!snapshot.url && <GameLinkPlaceholder />}

            {rooms && <RoomsPanel rooms={rooms} gameUrl={snapshot.url} isStale={live.isStale} />}

            <PowerHints launcher={launcher} isAwake={isKeptAwake(snapshot.status)} />
        </div>
    );
}

/** Holds the game link's place while idle, so the window doesn't jump when the QR code arrives. */
function GameLinkPlaceholder() {
    return (
        <section aria-label="Join the game" className="launcher-glass flex flex-col gap-3 p-4">
            <p aria-hidden="true" className="launcher-eyebrow">Game link</p>
            <p className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-3 py-5 text-center text-sm text-slate-500">
                The QR code and link show here once hosting starts.
            </p>
        </section>
    );
}

/**
 * Start while idle, Stop while running, a disabled "Stopping…" while stopping. Nothing while
 * failed: the failure panel's Retry takes its place.
 * @param {{ status: import('../shared/launcherBridge').HostingStatus,
 *   onStart: () => void, onStop: () => void }} props
 */
function HostingButton({ status, onStart, onStop }) {
    if (status === 'idle') {
        return <Button size="lg" className={START_BUTTON_CLASSES} onClick={onStart}>Start hosting</Button>;
    }
    if (isSessionRunning(status)) {
        return <Button size="lg" variant="destructive" className={STOP_BUTTON_CLASSES} onClick={onStop}>Stop hosting</Button>;
    }
    if (status === 'stopping') {
        return <Button size="lg" variant="destructive" className={STOP_BUTTON_CLASSES} disabled>Stopping…</Button>;
    }
    return null;
}

/**
 * The visible "rescan" banner. Its text is hidden from screen readers, which hear it once
 * through the LiveAnnouncement above it.
 * @param {{ onDismiss: () => void }} props
 */
function UrlChangedBanner({ onDismiss }) {
    return (
        <section
            aria-label="Link changed"
            className="flex items-center justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
            <p aria-hidden="true">{LINK_CHANGED_TEXT}</p>
            <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>
        </section>
    );
}

/**
 * The lid/power reminder, and a warning while on battery: keep-awake stops the laptop
 * sleeping, not closing the lid, and hosting all evening drains a battery (decision 6). While
 * the computer is kept awake the reminder says so (X66).
 * @param {{ launcher: LauncherBridge, isAwake: boolean }} props
 */
function PowerHints({ launcher, isAwake }) {
    const onBattery = useOnBattery(launcher);

    return (
        <div className="flex flex-col gap-2 text-sm">
            <LiveAnnouncement text={onBattery ? BATTERY_WARNING_TEXT : ''} testId="battery-announcement" />
            {onBattery && (
                <p aria-hidden="true" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900">
                    {BATTERY_WARNING_TEXT}
                </p>
            )}
            <p className="launcher-hint px-3 py-2.5">{isAwake ? AWAKE_HINT_TEXT : IDLE_HINT_TEXT}</p>
        </div>
    );
}
