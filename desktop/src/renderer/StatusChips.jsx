import { LoaderCircle } from 'lucide-react';
import React from 'react';
import { describeHosting, describeServer, describeTunnel } from './hostingStatus.js';

/** @typedef {import('./hostingStatus.js').ChipState} ChipState */

/**
 * The server and tunnel chips. They are hidden from screen readers, which hear the one
 * sentence below instead, announced whenever it changes.
 * @param {{ snapshot: import('../shared/launcherBridge').HostingSnapshot }} props
 */
export default function StatusChips({ snapshot }) {
    return (
        <div>
            <div aria-hidden="true" className="flex flex-wrap gap-2">
                <Chip name="Server" state={describeServer(snapshot.status)} />
                <Chip name="Tunnel" state={describeTunnel(snapshot)} />
            </div>
            <p aria-live="polite" className="sr-only">{describeHosting(snapshot)}</p>
        </div>
    );
}

// Tones where the part is on its way somewhere, so the chip spins instead of showing a dot (X75).
const SPINNING_TONES = ['busy', 'warn'];

/** @param {{ name: string, state: ChipState }} props */
function Chip({ name, state }) {
    const isSpinning = SPINNING_TONES.includes(state.tone);

    return (
        <span data-tone={state.tone} className="launcher-chip inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium">
            {isSpinning && <LoaderCircle className="launcher-chip-spinner" />}
            {!isSpinning && <span className="launcher-chip-dot" />}
            <span className="font-semibold">{name}</span>
            <span>{state.label}</span>
        </span>
    );
}
