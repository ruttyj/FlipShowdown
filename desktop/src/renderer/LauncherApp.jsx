import React from 'react';
import { BrandWordmark } from '@/components/logo/Wordmark';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import HomeScreen from './HomeScreen.jsx';
import { useAppVersion } from './launcherHooks.js';
import SettingsScreen from './SettingsScreen.jsx';
import UpdateBanner from './UpdateBanner.jsx';
import { useHostingSession } from './useHostingSession.js';

/** @typedef {import('../shared/launcherBridge').LauncherBridge} LauncherBridge */

/**
 * The launcher window: a Home tab that hosts the game and a Settings tab. Everything it does
 * goes through `launcher` (window.launcher in the app, a fake in tests). It is always the
 * Classic look, whatever the system theme (X65).
 * @param {{ launcher: LauncherBridge }} props
 */
export default function LauncherApp({ launcher }) {
    const hosting = useHostingSession(launcher);
    const version = useAppVersion(launcher);
    // null until the first snapshot arrives, so Settings doesn't offer Reset data meanwhile.
    const status = hosting.snapshot?.status ?? null;

    return (
        <div data-game-mode="classic" className="game-screen-bg flex h-screen flex-col">
            {/* Stands in for the hidden native title bar; the h1 below is the page's name. */}
            <div className="launcher-titlebar" aria-hidden="true">Flip Showdown</div>
            {/* Only this area scrolls, so its scrollbar starts below the window buttons. It is
                relative so absolute children (the sr-only announcements) are placed and clipped in
                it; without that they hang off the window and give the page a second scrollbar. */}
            <div className="launcher-scroll relative min-h-0 flex-1 overflow-y-auto">
                <Tabs defaultValue="home" className="mx-auto flex max-w-xl flex-col gap-4 p-4 sm:p-6">
                    <header className="flex items-center justify-between gap-3">
                        <Wordmark />
                        <TabsList aria-label="Launcher sections" className="launcher-tabs rounded-xl">
                            <TabsTrigger value="home" className="rounded-lg px-4">Home</TabsTrigger>
                            <TabsTrigger value="settings" className="rounded-lg px-4">Settings</TabsTrigger>
                        </TabsList>
                        {version && <p className="text-xs text-indigo-100/70">Version {version}</p>}
                    </header>

                    <UpdateBanner launcher={launcher} />

                    <TabsContent value="home" className="mt-0">
                        <HomeScreen launcher={launcher} hosting={hosting} />
                    </TabsContent>
                    <TabsContent value="settings" className="mt-0">
                        <SettingsScreen launcher={launcher} status={status} />
                    </TabsContent>
                </Tabs>
            </div>
        </div>
    );
}

/** The app's brand logo, small and static, read by screen readers as plain words. */
function Wordmark() {
    return (
        <h1 aria-label="Flip Showdown" className="launcher-wordmark">
            <span aria-hidden="true">
                <BrandWordmark fontClass="text-[24px]" />
            </span>
        </h1>
    );
}
