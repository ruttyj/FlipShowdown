import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { errorMessage } from './errorMessage.js';
import TunnelQrCode from './TunnelQrCode.jsx';

/** @typedef {import('../shared/launcherBridge').LauncherBridge} LauncherBridge */

const GAME_LINK_INPUT_ID = 'game-link';

/**
 * The QR code players scan, the link itself with Copy, and Open game for the host.
 * @param {{ launcher: LauncherBridge, url: string }} props
 */
export default function GameLinkPanel({ launcher, url }) {
    const [message, setMessage] = useState('');
    const [isOpening, setIsOpening] = useState(false);

    async function copyLink() {
        try {
            await navigator.clipboard.writeText(url);
            setMessage('Link copied.');
        } catch {
            setMessage("Couldn't copy the link. Select it and copy it by hand.");
        }
    }

    // The main process waits out the new hostname's DNS delay first, so this can take seconds.
    // It rejects when Windows can't open the link (no default browser), so that is shown too.
    async function openGame() {
        setIsOpening(true);
        setMessage('');
        try {
            const result = await launcher.openGame();
            if (result.ok === false) {
                setMessage(result.error);
            }
        } catch (error) {
            setMessage(`Couldn't open the game: ${errorMessage(error)}`);
        } finally {
            setIsOpening(false);
        }
    }

    return (
        <section aria-label="Join the game" className="launcher-glass flex flex-col gap-3 p-4">
            <p aria-hidden="true" className="launcher-eyebrow">Game link</p>
            {/* The lobby's own card, so the laptop and the phones look like one app (X65). */}
            <div className="room-code-card flex flex-col items-center gap-3 rounded-2xl p-5 shadow-lg shadow-indigo-950/50">
                <TunnelQrCode url={url} />
                <p className="text-center text-sm text-white/80">Players scan this with their phone camera.</p>
            </div>

            <div className="flex w-full flex-col gap-1.5">
                <label htmlFor={GAME_LINK_INPUT_ID} className="sr-only">Game link</label>
                <div className="flex gap-2">
                    <Input
                        id={GAME_LINK_INPUT_ID}
                        readOnly
                        value={url}
                        onFocus={(event) => event.target.select()}
                        className="launcher-well h-10 font-mono"
                    />
                    <Button variant="outline" className="h-10 rounded-xl font-bold text-indigo-950 shadow-sm" onClick={copyLink}>
                        Copy link
                    </Button>
                </div>
            </div>

            <Button
                className="launcher-action h-11 w-full"
                onClick={openGame}
                disabled={isOpening}
            >
                {isOpening ? 'Opening…' : 'Open game'}
            </Button>
            <p aria-live="polite" className="min-h-5 text-sm text-slate-600">{message}</p>
        </section>
    );
}
