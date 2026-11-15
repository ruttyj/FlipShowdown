import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { errorMessage } from './errorMessage.js';
import { useAvailableUpdate, useUpdateStatus } from './launcherHooks.js';
import LiveAnnouncement from './LiveAnnouncement.jsx';

/** @typedef {import('../shared/launcherBridge').LauncherBridge} LauncherBridge */
/** @typedef {import('../shared/launcherBridge').UpdateResult} UpdateResult */
/** @typedef {import('../shared/launcherBridge').UpdateStatus} UpdateStatus */
/** @typedef {import('../shared/launcherBridge').HostingStatus} HostingStatus */

/**
 * @typedef {object} NoticeProps
 * @property {LauncherBridge} launcher
 * @property {UpdateResult} update
 * @property {UpdateStatus | null} updateStatus
 * @property {HostingStatus | null} hostingStatus  null until the first snapshot arrives
 */

/**
 * Says when a newer release is out. Where the build can install it (Windows, the Linux AppImage),
 * Update downloads it in the app and Restart to update installs it (X90). macOS builds aren't
 * Developer ID signed, so there, from source, and whenever the in-app download fails, Download
 * opens the release page instead. The announcement is mounted before the check replies, so
 * screen readers hear the banner when it appears.
 * @param {{ launcher: LauncherBridge, hostingStatus: HostingStatus | null }} props
 */
export default function UpdateBanner({ launcher, hostingStatus }) {
    const update = useAvailableUpdate(launcher);
    const updateStatus = useUpdateStatus(launcher);
    const [isDismissed, setIsDismissed] = useState(false);
    const isShown = update !== null && !isDismissed;

    let announcement = '';
    if (isShown) {
        announcement = describeUpdate(update, updateStatus);
    }

    return (
        <>
            <LiveAnnouncement text={announcement} testId="update-announcement" />
            {isShown && (
                <UpdateNotice
                    launcher={launcher}
                    update={update}
                    updateStatus={updateStatus}
                    hostingStatus={hostingStatus}
                    onDismiss={() => setIsDismissed(true)}
                />
            )}
        </>
    );
}

// --- Wording -------------------------------------------------------------------------------

/**
 * @param {UpdateResult} update
 * @param {UpdateStatus | null} updateStatus
 */
function describeUpdate(update, updateStatus) {
    if (updateStatus?.phase === 'ready') {
        return `Version ${update.latestVersion} has downloaded.`;
    }
    return `Version ${update.latestVersion} is available.`;
}

/**
 * What to do with the downloaded installer, for builds that can't install it themselves.
 * @param {UpdateStatus | null} updateStatus
 */
function manualInstallHint(updateStatus) {
    if (updateStatus?.unsupportedReason === 'macos-unsigned') {
        return 'Quit Flip Showdown, open the downloaded file and drag Flip Showdown into Applications to replace this version.';
    }
    return '';
}

/** @param {HostingStatus | null} hostingStatus */
function canRestartNow(hostingStatus) {
    return hostingStatus === 'idle' || hostingStatus === 'failed';
}

// --- Banner --------------------------------------------------------------------------------

/**
 * The visible banner. Download opens the release page in the browser, which fails when Windows
 * has no browser to open it with.
 * @param {NoticeProps & { onDismiss: () => void }} props
 */
function UpdateNotice({ launcher, update, updateStatus, hostingStatus, onDismiss }) {
    const [requestError, setRequestError] = useState('');
    const canInstallInApp = updateStatus?.canInstall === true;
    const phase = updateStatus?.phase ?? 'idle';

    async function openDownloadPage() {
        setRequestError('');
        try {
            await launcher.openExternal(update.url);
        } catch (openError) {
            setRequestError(`Couldn't open the download page: ${errorMessage(openError)}`);
        }
    }

    // A failed download also arrives as a 'failed' status, which shows its own error, so only a
    // request that never reached the updater is reported here.
    async function startDownload() {
        setRequestError('');
        try {
            await launcher.downloadUpdate();
        } catch (downloadError) {
            setRequestError(`The update didn't download: ${errorMessage(downloadError)}`);
        }
    }

    async function restart() {
        setRequestError('');
        try {
            const result = await launcher.installUpdate();
            // `in` rather than `!result.ok`: the typecheck runs without strictNullChecks, where
            // the ok flag doesn't narrow the union.
            if ('error' in result) {
                setRequestError(result.error);
            }
        } catch (installError) {
            setRequestError(`Couldn't restart to update: ${errorMessage(installError)}`);
        }
    }

    let error = requestError;
    if (!error && canInstallInApp && phase === 'failed') {
        error = `The update didn't download: ${updateStatus?.error}`;
    }

    const actions = { openDownloadPage, startDownload, restart, onDismiss };
    return (
        <section
            aria-label="Update available"
            className="launcher-glass flex flex-col gap-2 px-4 py-3 text-sm"
        >
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p aria-hidden="true">{describeUpdate(update, updateStatus)}</p>
                <div className="flex gap-2">
                    <UpdateActions
                        canInstallInApp={canInstallInApp}
                        phase={phase}
                        hostingStatus={hostingStatus}
                        actions={actions}
                    />
                    <Button size="sm" variant="ghost" aria-label="Dismiss update" onClick={onDismiss}>
                        Dismiss
                    </Button>
                </div>
            </div>
            <UpdateDetails
                update={update}
                updateStatus={updateStatus}
                canInstallInApp={canInstallInApp}
                hostingStatus={hostingStatus}
            />
            {error && <p role="alert" className="text-destructive">{error}</p>}
        </section>
    );
}

/**
 * The banner's buttons for the current step: Update, then Restart to update, with the release
 * page as the fallback wherever the app can't (or failed to) install it.
 * @param {{ canInstallInApp: boolean, phase: UpdateStatus['phase'], hostingStatus: HostingStatus | null,
 *   actions: { openDownloadPage: () => void, startDownload: () => void, restart: () => void } }} props
 */
function UpdateActions({ canInstallInApp, phase, hostingStatus, actions }) {
    if (!canInstallInApp) {
        return <Button size="sm" onClick={actions.openDownloadPage}>Download</Button>;
    }

    if (phase === 'idle') {
        return <Button size="sm" onClick={actions.startDownload}>Update</Button>;
    }
    if (phase === 'ready') {
        return (
            <Button size="sm" disabled={!canRestartNow(hostingStatus)} onClick={actions.restart}>
                Restart to update
            </Button>
        );
    }
    if (phase === 'failed') {
        return (
            <>
                <Button size="sm" onClick={actions.startDownload}>Try again</Button>
                <Button size="sm" variant="outline" onClick={actions.openDownloadPage}>Download</Button>
            </>
        );
    }
    // Downloading: the progress bar below says how far along it is.
    return null;
}

/**
 * The line under the buttons: download progress, what happens on restart, or how to install by
 * hand on macOS.
 * @param {Omit<NoticeProps, 'launcher'> & { canInstallInApp: boolean }} props
 */
function UpdateDetails({ update, updateStatus, canInstallInApp, hostingStatus }) {
    if (!canInstallInApp) {
        const hint = manualInstallHint(updateStatus);
        if (!hint) {
            return null;
        }
        return <p className="text-xs text-indigo-100/80">{hint}</p>;
    }

    if (updateStatus?.phase === 'downloading') {
        return <DownloadProgress version={update.latestVersion} percent={updateStatus.percent ?? 0} />;
    }
    if (updateStatus?.phase === 'ready') {
        return <RestartHint hostingStatus={hostingStatus} />;
    }
    return null;
}

/** @param {{ version: string | null, percent: number }} props */
function DownloadProgress({ version, percent }) {
    return (
        <div className="flex items-center gap-3">
            <div
                role="progressbar"
                aria-label={`Downloading version ${version}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="h-2 flex-1 overflow-hidden rounded-full bg-white/20"
            >
                <div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${percent}%` }} />
            </div>
            <p className="text-xs tabular-nums">Downloading… {percent}%</p>
        </div>
    );
}

/** @param {{ hostingStatus: HostingStatus | null }} props */
function RestartHint({ hostingStatus }) {
    // Unknown until the first snapshot: the button stays disabled, but there is nothing to say yet.
    if (hostingStatus === null) {
        return null;
    }
    if (!canRestartNow(hostingStatus)) {
        return <p className="text-xs text-indigo-100/80">Stop hosting to restart and update.</p>;
    }
    return <p className="text-xs text-indigo-100/80">Restart now, or it installs the next time you quit.</p>;
}
