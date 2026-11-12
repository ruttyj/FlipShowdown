import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useCopyState } from './copyState.js';
import { describeStage, roomJoinUrl } from './roomList.js';
import TunnelQrCode from './TunnelQrCode.jsx';

/** @typedef {import('../shared/launcherBridge').RoomStat} RoomStat */

const NOBODY_ONLINE_TEXT = 'No one is online in this room right now. The code still works.';

/**
 * The join dialog for one room (X66): its code, large, on the lobby's card, and a QR code for the
 * room's join link. Open while `code` is set and there is a game link. `room` is null once nobody
 * in it is online; the code still works, so the dialog stays and says so.
 * @param {{ code: string | null, room: RoomStat | null, gameUrl: string | null, onClose: () => void,
 *   onCloseAutoFocus: (event: Event) => void }} props
 */
export default function RoomQrDialog({ code, room, gameUrl, onClose, onCloseAutoFocus }) {
    const isOpen = code !== null && gameUrl !== null;

    return (
        <Dialog open={isOpen} onOpenChange={(open) => closeWhenDismissed(open, onClose)}>
            {isOpen && (
                <DialogContent className="launcher-glass max-w-sm" onCloseAutoFocus={onCloseAutoFocus}>
                    <DialogTitle>Join room {code}</DialogTitle>
                    <DialogDescription className="text-slate-600">{describeRoom(room)}</DialogDescription>
                    <div className="room-code-card flex flex-col items-center gap-2 rounded-2xl p-5 text-center">
                        <p className="text-xs font-bold uppercase tracking-[0.2em] text-white/80">Room code</p>
                        <p className="font-mono text-4xl font-bold tracking-[0.3em] text-white">{code}</p>
                        <TunnelQrCode url={roomJoinUrl(gameUrl, code)} alt={`QR code to join room ${code}`} />
                        <p className="text-sm text-white/80">Scan to join this room.</p>
                    </div>
                    <CopyButtons code={code} joinUrl={roomJoinUrl(gameUrl, code)} />
                </DialogContent>
            )}
        </Dialog>
    );
}

/**
 * Copy code and Copy join link, with one polite message for whichever was used last.
 * @param {{ code: string, joinUrl: string }} props
 */
function CopyButtons({ code, joinUrl }) {
    const codeCopy = useCopyState();
    const linkCopy = useCopyState();

    return (
        <div className="flex flex-col gap-1.5">
            <div className="flex gap-2">
                <Button variant="outline" className="h-10 flex-1 rounded-xl font-bold text-indigo-950" onClick={() => codeCopy.copy(code)}>
                    Copy code
                </Button>
                <Button variant="outline" className="h-10 flex-1 rounded-xl font-bold text-indigo-950" onClick={() => linkCopy.copy(joinUrl)}>
                    Copy join link
                </Button>
            </div>
            <p aria-live="polite" className="min-h-5 text-sm text-slate-600">
                {describeCopy(codeCopy.state, 'Room code')}
                {describeCopy(linkCopy.state, 'Join link')}
            </p>
        </div>
    );
}

/**
 * @param {import('./copyState.js').CopyState} state
 * @param {string} what
 */
function describeCopy(state, what) {
    if (state === 'copied') {
        return `${what} copied. `;
    }
    if (state === 'failed') {
        return `Couldn't copy the ${what.toLowerCase()}. `;
    }
    return '';
}

/**
 * @param {boolean} open
 * @param {() => void} onClose
 */
function closeWhenDismissed(open, onClose) {
    if (!open) {
        onClose();
    }
}

/** @param {RoomStat | null} room */
function describeRoom(room) {
    if (!room) {
        return NOBODY_ONLINE_TEXT;
    }
    return `${describeStage(room)} · ${room.online} of ${room.players} online`;
}
