import { Check, Copy, QrCode } from 'lucide-react';
import React from 'react';
import { useCopyState } from './copyState.js';
import { describeStage } from './roomList.js';

/** @typedef {import('../shared/launcherBridge').RoomStat} RoomStat */

const MAX_PIPS = 8;

/**
 * One room in play: its code (click to copy), a QR button, where it's up to, and who is online.
 * @param {{ room: RoomStat, canShowQr: boolean, onShowQr: (opener: HTMLElement) => void }} props
 */
export default function RoomRow({ room, canShowQr, onShowQr }) {
    const qrTitle = canShowQr ? 'Show QR code' : 'The QR code needs the game link';

    return (
        <li className="launcher-room">
            <CopyCodeButton code={room.code} />
            <button
                type="button"
                className="launcher-room-qr"
                aria-label={`Show QR code for room ${room.code}`}
                title={qrTitle}
                disabled={!canShowQr}
                onClick={(event) => onShowQr(event.currentTarget)}
            >
                <QrCode aria-hidden="true" className="h-4 w-4" />
            </button>
            <span className="launcher-room-stage">{describeStage(room)}</span>
            <OnlinePips online={room.online} players={room.players} />
            <span className="launcher-room-count">
                <span aria-hidden="true">{room.online}/{room.players}</span>
                <span className="sr-only">{room.online} of {room.players} online</span>
            </span>
        </li>
    );
}

/**
 * The code as a button that copies it, then reads "Copied" for two seconds. The button keeps its
 * width, so the row doesn't shift, and its name stays the code; the outcome is announced politely.
 * @param {{ code: string }} props
 */
function CopyCodeButton({ code }) {
    const { state, copy } = useCopyState();

    return (
        <>
            <button
                type="button"
                className="launcher-room-code"
                data-state={state}
                aria-label={`Copy room code ${code}`}
                onClick={() => copy(code)}
            >
                <CopyCodeLabel code={code} state={state} />
            </button>
            <span role="status" className="sr-only">
                {state === 'copied' && `Room code ${code} copied.`}
                {state === 'failed' && `Couldn't copy room code ${code}.`}
            </span>
        </>
    );
}

/** @param {{ code: string, state: import('./copyState.js').CopyState }} props */
function CopyCodeLabel({ code, state }) {
    if (state === 'copied') {
        return <span aria-hidden="true" className="launcher-room-code-text"><Check className="h-3.5 w-3.5" />Copied</span>;
    }
    if (state === 'failed') {
        return <span aria-hidden="true" className="launcher-room-code-text">Couldn&apos;t copy</span>;
    }
    return (
        <span aria-hidden="true" className="launcher-room-code-text">
            {code}
            <Copy className="launcher-room-code-icon h-3.5 w-3.5" />
        </span>
    );
}

/**
 * A dot per player, filled when online, up to MAX_PIPS; the count beside them is the real number.
 * @param {{ online: number, players: number }} props
 */
function OnlinePips({ online, players }) {
    const pips = [];
    for (let index = 0; index < Math.min(players, MAX_PIPS); index += 1) {
        pips.push(<i key={index} data-online={index < online} className="launcher-room-pip" />);
    }

    return <span aria-hidden="true" className="launcher-room-pips">{pips}</span>;
}
