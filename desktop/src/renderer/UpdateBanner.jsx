import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { errorMessage } from './errorMessage.js';
import { useAvailableUpdate } from './launcherHooks.js';
import LiveAnnouncement from './LiveAnnouncement.jsx';

/** @typedef {import('../shared/launcherBridge').LauncherBridge} LauncherBridge */
/** @typedef {import('../shared/launcherBridge').UpdateResult} UpdateResult */

/**
 * Says when a newer release is out and links to it. Notify-only: the user downloads and installs
 * it themselves (decision 16). The announcement is mounted before the check replies, so screen
 * readers hear the banner when it appears.
 * @param {{ launcher: LauncherBridge }} props
 */
export default function UpdateBanner({ launcher }) {
    const update = useAvailableUpdate(launcher);
    const [isDismissed, setIsDismissed] = useState(false);
    const isShown = update !== null && !isDismissed;

    let announcement = '';
    if (isShown) {
        announcement = describeUpdate(update);
    }

    return (
        <>
            <LiveAnnouncement text={announcement} testId="update-announcement" />
            {isShown && <UpdateNotice launcher={launcher} update={update} onDismiss={() => setIsDismissed(true)} />}
        </>
    );
}

/** @param {UpdateResult} update */
function describeUpdate(update) {
    return `Version ${update.latestVersion} is available.`;
}

/**
 * The visible banner: Download opens the release page in the browser, which fails when Windows
 * has no browser to open it with.
 * @param {{ launcher: LauncherBridge, update: UpdateResult, onDismiss: () => void }} props
 */
function UpdateNotice({ launcher, update, onDismiss }) {
    const [error, setError] = useState('');

    async function download() {
        setError('');
        try {
            await launcher.openExternal(update.url);
        } catch (openError) {
            setError(`Couldn't open the download page: ${errorMessage(openError)}`);
        }
    }

    return (
        <section
            aria-label="Update available"
            className="launcher-glass flex flex-col gap-2 px-4 py-3 text-sm"
        >
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p aria-hidden="true">{describeUpdate(update)}</p>
                <div className="flex gap-2">
                    <Button size="sm" onClick={download}>Download</Button>
                    <Button size="sm" variant="ghost" aria-label="Dismiss update" onClick={onDismiss}>
                        Dismiss
                    </Button>
                </div>
            </div>
            {error && <p role="alert" className="text-destructive">{error}</p>}
        </section>
    );
}
