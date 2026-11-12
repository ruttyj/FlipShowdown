import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { backend } from '@/api/backend';
import { game } from '@/api/game';
import { defaultPlayerName, forgetLeftRoom, hasLeftRoom, rememberLeftRoom } from '@/lib/autoJoin';
import { useAuth } from '@/lib/AuthContext';
import { treatCodesAsDone } from '@/lib/gameActionOutcomes';
import { createPageUrl } from '@/utils';

// --- Signed-in user ----------------------------------------------------------------

/**
 * The signed-in user from AuthContext (which has already asked the server), with their name
 * suggested for joining. Signed-out visitors are sent to login. Null until known.
 */
function useSignedInUser(setPlayerName) {
    const { user, isLoadingAuth } = useAuth();

    useEffect(() => {
        if (isLoadingAuth) {
            return;
        }

        if (!user) {
            backend.auth.redirectToLogin(window.location.href);
            return;
        }
        setPlayerName(defaultPlayerName(user));
    }, [user, isLoadingAuth, setPlayerName]);

    return user;
}

// --- Auto-join ---------------------------------------------------------------------

/**
 * Whether opening this room should join me. Not when I'm already in it, were just removed
 * from it, it has closed (X6), or I was kicked from or left it before, even in an earlier
 * visit (X3): the Join screen is the way back in then.
 */
function shouldAutoJoin({ roomData, roomCode }) {
    const { isMember, removedFromRoom, roomGone, room } = roomData;
    return !isMember
        && !removedFromRoom
        && !roomGone
        && !hasLeftRoom(roomCode, room?.id);
}

/**
 * Joins the room under my account name as soon as I open it signed in, so someone who
 * scanned the code and typed their name at login isn't asked for it again. Tried once per
 * room: a failed join, or being kicked, leaves the Join screen as the way back in.
 * Returns true while the join is still to come, so the Join screen isn't flashed meanwhile.
 */
function useAutoJoin({ roomData, roomCode, user, join }) {
    const { status, room } = roomData;
    // Room id already handled (joined, tried, or skipped); the ref guards the effect, the
    // state drives the render.
    const handledRoomIdRef = useRef(null);
    const [handledRoomId, setHandledRoomId] = useState(null);

    const roomId = room?.id ?? null;
    const isReady = status === 'ready' && roomId !== null && Boolean(user);
    const wantsJoin = shouldAutoJoin({ roomData, roomCode });
    const isPending = isReady && wantsJoin && handledRoomId !== roomId;

    useEffect(() => {
        if (!isReady || handledRoomIdRef.current === roomId) {
            return;
        }

        handledRoomIdRef.current = roomId;
        setHandledRoomId(roomId);
        if (wantsJoin) {
            join(defaultPlayerName(user));
        }
        // join is a fresh function each render; the ref makes this run once per room.
    }, [isReady, roomId, user, wantsJoin]);

    return isPending;
}

// --- Membership --------------------------------------------------------------------

/**
 * How I get in and out of the room: sign-in, joining by hand or automatically, leaving, and
 * finding out I was kicked.
 *
 * @param {object} context
 * @param {object} context.roomData  from useRoomData
 * @param {string|null} context.roomCode
 * @param {Function} context.perform  from useActionRunner
 * @param {(options: object) => Promise<boolean>} context.confirm  from useConfirmDialog
 * @param {() => void} context.onRemoved  I was kicked; only clears state, so a stale copy is fine
 */
export function useRoomMembership({ roomData, roomCode, perform, confirm, onRemoved }) {
    const navigate = useNavigate();
    const { room, isHost, myPlayer: currentPlayer, isMember: hasJoined } = roomData;

    const [playerName, setPlayerName] = useState('');
    const user = useSignedInUser(setPlayerName);
    // True from the moment a join starts until the room has been refetched after it, so the
    // spinner covers the whole join and a second tap can't send a second one meanwhile.
    const [isJoinPending, setIsJoinPending] = useState(false);
    // Set while I leave on purpose, so my own Player delete isn't reported as being kicked.
    const isLeavingRef = useRef(false);

    // My Player was deleted while the room is still open: I was kicked (bug 3.5). Remembered,
    // so reopening the room shows the Join screen instead of auto-joining me again (X3).
    useEffect(() => {
        if (roomData.removedFromRoom && !isLeavingRef.current) {
            rememberLeftRoom(roomCode, room?.id);
            toast.error('You were removed from the game');
            onRemoved();
        }
    }, [roomData.removedFromRoom]);

    /** @param {string} name */
    const join = async (name) => {
        const trimmedName = (name ?? '').trim();
        if (!trimmedName || !room || isJoinPending) {
            return undefined;
        }

        setIsJoinPending(true);
        const result = await perform('join', 'Join room', () => game.join(room.id, { name: trimmedName }),
            { refetchAfter: false });
        if (result) {
            forgetLeftRoom(roomCode);
            // Switches useRoomData to the member reads and the socket. If it still doesn't
            // show me, the Join screen comes back rather than a spinner that never ends;
            // joining again is safe, as the server returns my existing Player.
            await roomData.refetch();
        }
        setIsJoinPending(false);
        return result;
    };

    const isAutoJoinPending = useAutoJoin({ roomData, roomCode, user, join });

    const leaveWithoutAsking = async () => {
        if (!room || !currentPlayer) {
            return undefined;
        }

        isLeavingRef.current = true;
        // Already gone (e.g. kicked meanwhile, or a retry after a lost response) is done.
        const result = await perform('leave', 'Leave game', () =>
            treatCodesAsDone(() => game.leave(room.id), ['player_not_found']), { refetchAfter: false });
        if (!result) {
            isLeavingRef.current = false;
            return undefined;
        }

        // Coming back to this room shows the Join screen rather than re-joining me (X3).
        rememberLeftRoom(roomCode, room.id);
        navigate(createPageUrl('Home'));
        return result;
    };

    const leave = async () => {
        let description = 'You will be removed from this game and your scores will be deleted.';
        if (isHost) {
            description += ' Hosting passes to the next player.';
        }

        const confirmed = await confirm({
            title: 'Leave Game?',
            description,
            confirmText: 'Leave',
            variant: 'destructive',
        });
        if (!confirmed) {
            return undefined;
        }
        return leaveWithoutAsking();
    };

    return {
        isSigningIn: user === null,
        leave,
        joining: {
            name: playerName,
            changeName: setPlayerName,
            join,
            isJoining: isJoinPending,
            // Show a spinner, not the Join screen, until the automatic join has had its go.
            isAutoJoining: isAutoJoinPending || (isJoinPending && !hasJoined),
        },
    };
}
