import React, { useState } from 'react';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { errorMessage } from './errorMessage.js';

/** @typedef {import('../shared/launcherBridge').LauncherBridge} LauncherBridge */

const DISABLED_REASON_ID = 'reset-data-disabled-reason';

/**
 * Why Reset data is unavailable in this status, or null when it can run. The bridge allows it
 * only while idle: a running server holds the database open, and a failed session must be
 * dismissed (stopped) first. A null status (no snapshot yet) could be any of them.
 * @param {import('../shared/launcherBridge').HostingStatus | null} status
 */
function resetBlockedReason(status) {
    if (status === null) {
        return 'Checking whether the game is being hosted…';
    }
    if (status === 'idle') {
        return null;
    }
    if (status === 'failed') {
        return 'Dismiss the error on Home first.';
    }
    return 'Stop hosting first.';
}

/**
 * Deletes the game database after a confirm.
 * @param {{ launcher: LauncherBridge, status: import('../shared/launcherBridge').HostingStatus | null }} props
 */
export default function ResetDataSection({ launcher, status }) {
    const [isConfirming, setIsConfirming] = useState(false);
    const [message, setMessage] = useState('');
    const blockedReason = resetBlockedReason(status);
    const canReset = blockedReason === null;

    async function resetData() {
        setMessage('');
        try {
            const result = await launcher.resetData();
            if (result.ok === false) {
                setMessage(result.error);
                return;
            }
            setMessage('All game data was deleted.');
        } catch (error) {
            setMessage(`Couldn't reset the data: ${errorMessage(error)}`);
        }
    }

    return (
        <section aria-labelledby="reset-data-heading" className="flex flex-col gap-3">
            <h2 id="reset-data-heading" className="launcher-eyebrow">Reset data</h2>
            <p className="text-sm text-muted-foreground">Deletes every game, player and score saved on this computer.</p>
            <div className="flex items-center gap-3">
                <Button
                    variant="destructive"
                    className="rounded-xl font-bold"
                    disabled={!canReset}
                    aria-describedby={canReset ? undefined : DISABLED_REASON_ID}
                    onClick={() => setIsConfirming(true)}
                >
                    Reset data…
                </Button>
                {!canReset && (
                    <p id={DISABLED_REASON_ID} className="text-sm text-muted-foreground">{blockedReason}</p>
                )}
            </div>
            <p aria-live="polite" className="min-h-5 text-sm">{message}</p>

            <AlertDialog open={isConfirming} onOpenChange={setIsConfirming}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Reset all game data?</AlertDialogTitle>
                        <AlertDialogDescription>
                            This deletes every room, player and score on this computer. It can't be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={resetData}>Delete everything</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </section>
    );
}
