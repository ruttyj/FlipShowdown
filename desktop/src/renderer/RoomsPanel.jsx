import React, { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import RoomQrDialog from './RoomQrDialog.jsx';
import RoomRow from './RoomRow.jsx';
import { COLLAPSED_ROOM_ROWS, FILTER_FROM_ROOMS, keepOrder, visibleRooms } from './roomList.js';

/** @typedef {import('../shared/launcherBridge').RoomStat} RoomStat */

const ROOM_LIST_ID = 'launcher-room-list';

/**
 * The rooms in play, busiest first as the server sorts them (X66). Five rows, then "Show all";
 * the expanded list scrolls inside the panel and gets a filter once there are many rooms. With
 * no room in play it draws nothing but an open QR dialog.
 * @param {{ rooms: RoomStat[], gameUrl: string | null, isStale: boolean }} props
 */
export default function RoomsPanel({ rooms, gameUrl, isStale }) {
    const [isExpanded, setIsExpanded] = useState(false);
    const [filter, setFilter] = useState('');
    const qr = useQrDialog();
    const order = useStillOrderWhileHovered(rooms);

    const shown = visibleRooms(order.rooms, { isExpanded, filter });
    const canExpand = rooms.length > COLLAPSED_ROOM_ROWS;
    const hasFilter = isExpanded && rooms.length > FILTER_FROM_ROOMS;

    function toggle() {
        // Collapsing clears the filter, so the next "Show all" starts from every room.
        setFilter('');
        setIsExpanded((wasExpanded) => !wasExpanded);
    }

    const dialog = (
        <RoomQrDialog
            code={qr.code}
            room={findRoom(rooms, qr.code)}
            gameUrl={gameUrl}
            onClose={qr.close}
            onCloseAutoFocus={qr.returnFocus}
        />
    );
    // With no room in play the panel goes, but an open QR dialog stays: its code still works.
    if (rooms.length === 0) {
        return dialog;
    }

    return (
        <section aria-label="Rooms" data-stale={isStale} className="launcher-glass launcher-rooms-panel flex flex-col gap-2 p-4">
            <p className="launcher-eyebrow flex justify-between">
                <span aria-hidden="true">Rooms</span>
                <span>{rooms.length} in play</span>
            </p>
            {hasFilter && (
                <Input
                    aria-label="Filter rooms by code"
                    placeholder="Filter by room code"
                    className="launcher-well h-9"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                />
            )}
            <ul
                id={ROOM_LIST_ID}
                className="launcher-rooms"
                data-expanded={isExpanded}
                onPointerEnter={order.freeze}
                onPointerLeave={order.release}
            >
                {shown.map((room) => (
                    <RoomRow
                        key={room.code}
                        room={room}
                        canShowQr={gameUrl !== null}
                        onShowQr={(opener) => qr.open(room.code, opener)}
                    />
                ))}
            </ul>
            {shown.length === 0 && <p className="text-sm text-slate-500">No room code contains &quot;{filter}&quot;.</p>}
            {canExpand && <ShowAllButton isExpanded={isExpanded} total={rooms.length} onToggle={toggle} />}
            {dialog}
        </section>
    );
}

/** @param {{ isExpanded: boolean, total: number, onToggle: () => void }} props */
function ShowAllButton({ isExpanded, total, onToggle }) {
    const label = isExpanded ? 'Show fewer' : `Show all ${total} rooms`;

    return (
        <Button
            variant="ghost"
            size="sm"
            className="self-center font-bold text-indigo-900"
            aria-expanded={isExpanded}
            aria-controls={ROOM_LIST_ID}
            onClick={onToggle}
        >
            {label}
        </Button>
    );
}

/**
 * @param {RoomStat[]} rooms
 * @param {string | null} code
 */
function findRoom(rooms, code) {
    return rooms.find((room) => room.code === code) ?? null;
}

/**
 * Which room's QR dialog is open, and the button that opened it. The dialog has no trigger of
 * its own, so focus goes back to that button by hand on close (docs/testing.md).
 */
function useQrDialog() {
    const [code, setCode] = useState(/** @type {string | null} */ (null));
    const opener = useRef(/** @type {HTMLElement | null} */ (null));

    return {
        code,
        open(/** @type {string} */ roomCode, /** @type {HTMLElement} */ element) {
            opener.current = element;
            setCode(roomCode);
        },
        close() {
            setCode(null);
        },
        returnFocus(/** @type {Event} */ event) {
            if (opener.current?.isConnected) {
                event.preventDefault();
                opener.current.focus();
            }
        },
    };
}

/**
 * The rooms in their server order, except while the pointer is over the list: then the order it
 * had is kept (keepOrder), so a row doesn't move under a click.
 * @param {RoomStat[]} rooms
 * @returns {{ rooms: RoomStat[], freeze: () => void, release: () => void }}
 */
function useStillOrderWhileHovered(rooms) {
    const [frozenCodes, setFrozenCodes] = useState(/** @type {string[] | null} */ (null));

    let ordered = rooms;
    if (frozenCodes) {
        ordered = keepOrder(frozenCodes, rooms);
    }

    return {
        rooms: ordered,
        freeze: () => setFrozenCodes(ordered.map((room) => room.code)),
        release: () => setFrozenCodes(null),
    };
}
