import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useSound } from '@/components/useSound';
import { useValueTransition } from '@/hooks/useRoomData';
import { getRules, modeChangeMessage, modeTransition } from '@/lib/gameRules';
import { attackToast } from '@/lib/roundScores';

// --- Chimes ------------------------------------------------------------------------

/** Plays each status chime once per visit to that status. */
function useStatusChimes({ status, hasJoined }) {
    const { playChimeWaitingRoom, playChimeGameStart, playChimeGameEnd } = useSound();
    const [played, setPlayed] = useState({ waiting: false, playing: false, finished: false });

    useValueTransition(status, (_previous, next) => {
        if (next === 'waiting') {
            setPlayed({ waiting: false, playing: false, finished: false });
        }
    });

    useEffect(() => {
        if (status === 'waiting' && !played.waiting && hasJoined) {
            playChimeWaitingRoom();
            setPlayed((previous) => ({ ...previous, waiting: true }));
        }
    }, [status, played.waiting, hasJoined, playChimeWaitingRoom]);

    useEffect(() => {
        if (status === 'playing' && !played.playing) {
            playChimeGameStart();
            setPlayed((previous) => ({ ...previous, playing: true }));
        }
    }, [status, played.playing, playChimeGameStart]);

    useEffect(() => {
        if (status === 'finished' && !played.finished) {
            playChimeGameEnd();
            setPlayed((previous) => ({ ...previous, finished: true }));
        }
    }, [status, played.finished, playChimeGameEnd]);
}

/**
 * One soft bell each time the round goes up during a game, which is when the last player's score
 * moves everyone on (X64). The round is undefined on first render, so opening a room mid-game is
 * silent, and Start and Play Again set it to 1, never up.
 */
function useNewRoundChime({ status, round }) {
    const { playChimeNewRound } = useSound();

    useValueTransition(round, (previous, next) => {
        const isNextRound = previous !== undefined && next > previous;
        if (isNextRound && status === 'playing') {
            playChimeNewRound();
        }
    });
}

// --- Attention cues ----------------------------------------------------------------

/**
 * Nudges a player who has the phone in their pocket: the tab title (and a vibration) when
 * the turn comes to me, the game starts or the game ends. `previous` is undefined on the
 * first render, so opening a room that is already in a state never cues.
 */
function useAttentionCueTransitions({ room, myPlayerId, cue }) {
    useValueTransition(room?.current_turn_player_id, (previous, next) => {
        const isMyTurnNow = myPlayerId !== null && next === myPlayerId;
        if (previous !== undefined && isMyTurnNow) {
            cue('turn', 'Your turn');
        }
    });

    useValueTransition(room?.status, (previous, next) => {
        if (previous === undefined) {
            return;
        }
        // Finished to playing is a reopened game, which isn't a start.
        if (next === 'playing' && previous !== 'finished') {
            cue('gameStart', 'Game started');
        }
        if (next === 'finished') {
            cue('gameEnd', 'Game over');
        }
    });
}

/** Guests see the room change under them, so they get told why. The host pressed the button. */
function useReopenToast({ status, isHost }) {
    useValueTransition(status, (previous, next) => {
        if (previous === 'finished' && next === 'playing' && !isHost) {
            toast.info('Host reopened the game');
        }
    });
}

// --- Game mode ---------------------------------------------------------------------

/**
 * Tells the player in words when the room's mode changes, as the shift is easy to miss when looking
 * at the table. It goes by the same check as the shift, so first load, refetch and rejoin stay silent.
 */
function useModeChangeToast({ roomId, mode, isHost, hasEntryOpen }) {
    const previousRef = useRef({ roomId, mode });

    useEffect(() => {
        const previous = previousRef.current;
        previousRef.current = { roomId, mode };
        if (previous.roomId !== roomId || !modeTransition(previous.mode, mode)) {
            return;
        }

        const message = modeChangeMessage({ isHost, label: getRules(mode).label, hasEntryOpen });
        if (message) {
            toast.info(message);
        }
        // Only a change of mode says anything; the others are read as they are at that moment.
    }, [roomId, mode]);
}

// --- Flip 7 attacks ----------------------------------------------------------------

/**
 * Tells me when someone's Flip 7 takes 15 from me (X43), as the score table's mark is easy to miss.
 * Attacks already there when I first see the room stay silent, like chat. Each update replaces what
 * was seen, so an attack taken back and made again is told again.
 */
function useAttackToast({ status, roomId, roundScores, players, myPlayerId }) {
    // { key, scoreIds } for the room and player the ids were collected for, or null.
    const seenRef = useRef(null);

    useEffect(() => {
        if (status !== 'ready' || !roomId || !myPlayerId) {
            return;
        }

        const key = `${roomId}:${myPlayerId}`;
        const attacks = roundScores.filter((score) => score.flip7_attack_player_id === myPlayerId);
        const seen = seenRef.current;
        seenRef.current = { key, scoreIds: new Set(attacks.map((score) => score.id)) };
        if (seen?.key !== key) {
            return;
        }

        for (const attack of attacks) {
            if (!seen.scoreIds.has(attack.id)) {
                toast.info(attackToast(players, attack.player_id));
            }
        }
    }, [status, roomId, roundScores, players, myPlayerId]);
}

// --- Announcements -----------------------------------------------------------------

/**
 * What the room tells the player as it changes, in sound, the tab title and toasts. The screens
 * show none of it directly, so this takes the room's state and returns nothing.
 *
 * @param {object} context
 * @param {object} context.roomData  from useRoomData
 * @param {string|null} context.mode  the room's mode, null with no room yet
 * @param {boolean} context.hasEntryOpen  I have the scanner or manual entry open
 * @param {(kind: string, title: string) => void} context.cue  from useAttentionCues
 */
export function useRoomAnnouncements({ roomData, mode, hasEntryOpen, cue }) {
    const { status, room, players, roundScores, isHost, isMember, myPlayer } = roomData;
    const roomId = room?.id ?? null;
    const myPlayerId = myPlayer?.id ?? null;

    useModeChangeToast({ roomId, mode, isHost, hasEntryOpen });
    useStatusChimes({ status: room?.status, hasJoined: isMember });
    useNewRoundChime({ status: room?.status, round: room?.current_round });
    useAttentionCueTransitions({ room, myPlayerId, cue });
    useReopenToast({ status: room?.status, isHost });
    useAttackToast({ status, roomId, roundScores, players, myPlayerId });
}
