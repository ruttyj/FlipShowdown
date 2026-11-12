import { useEffect, useMemo, useRef, useState } from 'react';
import { roomChannel } from '@/api/backend';
import { selectEnteringPlayers } from '@/lib/entryStatus';

/**
 * Tells the room what I am doing, for the "entering cards" indicator (X40).
 *
 * The status isn't cleared when the page hides or the socket drops, because opening the camera
 * does both (X26). A page that dies mid-entry is covered by the server's time limit.
 *
 * @param {object} status
 * @param {string|null} status.roomId
 * @param {number|null} status.round  the round being entered; may be null when `state` is null
 * @param {'scanning'|'typing'|null} status.state  null while I am not entering
 * @returns {(state: 'scanning'|'typing') => void} says the state now, rather than on the next render
 */
export function useEntryStatus({ roomId, round, state }) {
    const isEntering = Boolean(roomId) && state !== null;
    const entryRef = useRef(null);

    // Separate from the effect below so typing -> scanning sends just the new state. It keeps the
    // round it was set up with, since the caller's round goes null at the moment entry closes.
    useEffect(() => {
        if (!isEntering) {
            return undefined;
        }

        const entry = roomChannel.startEntry(roomId, round);
        entryRef.current = entry;

        return () => {
            entryRef.current = null;
            entry.close();
        };
    }, [isEntering, roomId, round]);

    useEffect(() => {
        if (isEntering) {
            entryRef.current.announce(state);
        }
    }, [isEntering, roomId, round, state]);

    return (nextState) => {
        entryRef.current?.announce(nextState);
    };
}

/**
 * The other players entering cards this round, as [{ id, name, state }]. Empty while my own
 * connection is down, rather than showing stale data.
 *
 * @param {object} context
 * @param {string|null} context.roomId
 * @param {number|undefined} context.round  the room's current round
 * @param {object[]} context.players
 * @param {string|undefined} context.currentPlayerId
 */
export function useEnteringPlayers({ roomId, round, players, currentPlayerId }) {
    const [entries, setEntries] = useState([]);

    useEffect(() => {
        const stopWatching = roomChannel.watchEntering(roomId, setEntries);

        return () => {
            stopWatching();
            setEntries([]);
        };
    }, [roomId]);

    return useMemo(() => {
        return selectEnteringPlayers({ entries, players, currentPlayerId, round });
    }, [entries, players, currentPlayerId, round]);
}
