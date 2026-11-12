import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAttentionCues } from '@/hooks/useAttentionCues';
import { useEnteringPlayers } from '@/hooks/useEntryStatus';
import { useGameModeTheme } from '@/hooks/useGameModeTheme';
import { useRoomChat } from '@/hooks/useRoomChat';
import { useRoomData } from '@/hooks/useRoomData';
import { getRules } from '@/lib/gameRules';
import { createPageUrl } from '@/utils';
import { readRoomCode } from '@/lib/roomUrl';
import { useActionRunner } from './useActionRunner';
import { useConfirmDialog } from './useConfirmDialog';
import { useHostActions } from './useHostActions';
import { useRoomAnnouncements } from './useRoomAnnouncements';
import { useRoomMembership } from './useRoomMembership';
import { useScanModels } from './useScanModels';
import { useScoreEntry } from './useScoreEntry';

/**
 * Everything the GameRoom screens need, grouped by what it is about. All writes go through the
 * server actions in src/api/game.js.
 *
 * - load: how far the room has got (status, error, isRoomGone, isSigningIn, retry)
 * - table: the room as it stands (room, roomCode, players, roundScores, currentPlayer, isHost,
 *   isEditMode, hasJoined, and busy: action name -> true while it is running, e.g. busy.start)
 * - theme: the room's look (mode, shift)
 * - joining, leave: see useRoomMembership
 * - goHome
 * - scoreEntry: see useScoreEntry, plus isOpen and enteringPlayers (the others entering cards now)
 * - scanModels: see useScanModels
 * - host: see useHostActions
 * - chat: see useRoomChat
 * - dialogs: what RoomDialogs shows (confirmation, isGamesWonOpen, openGamesWon, closeGamesWon)
 */
export function useGameRoom() {
    const navigate = useNavigate();

    const roomCode = readRoomCode(window.location.pathname);
    const roomData = useRoomData(roomCode);
    const { room, players, roundScores, isHost, isEditMode } = roomData;
    const currentPlayer = roomData.myPlayer;
    const roomId = room?.id ?? null;

    const [isGamesWonOpen, setIsGamesWonOpen] = useState(false);
    const cue = useAttentionCues();
    const scanModels = useScanModels();
    const { confirmDialog, confirm, ask } = useConfirmDialog();
    const { busy, perform } = useActionRunner({ refetch: roomData.refetch });

    const host = useHostActions({ room, players, isHost, perform, confirm, navigate });
    const scoreEntry = useScoreEntry({
        room,
        currentPlayer,
        roundScores,
        isHost,
        perform,
        ask,
    });
    const enteringPlayers = useEnteringPlayers({
        roomId,
        round: room?.current_round,
        players,
        currentPlayerId: currentPlayer?.id,
    });
    const membership = useRoomMembership({
        roomData,
        roomCode,
        perform,
        confirm,
        onRemoved: scoreEntry.closeScoreEntry,
    });

    // A stored room with a missing or unknown mode reads as classic, and null means no room yet.
    const roomMode = room ? getRules(room.game_mode).id : null;
    const { themeMode, modeShift } = useGameModeTheme({ roomId, mode: roomMode });
    const hasEntryOpen = scoreEntry.showScanner || scoreEntry.showManualEntry;
    useRoomAnnouncements({ roomData, mode: roomMode, hasEntryOpen, cue });

    const chat = useRoomChat({
        status: roomData.status,
        roomId,
        chatMessages: roomData.chatMessages,
        players,
        myPlayer: currentPlayer,
        cue,
    });

    return {
        load: {
            status: roomData.status,
            error: roomData.error,
            isRoomGone: roomData.roomGone,
            isSigningIn: membership.isSigningIn,
            retry: roomData.retry,
        },
        table: {
            room,
            roomCode,
            players,
            roundScores,
            currentPlayer,
            isHost,
            isEditMode,
            hasJoined: roomData.isMember,
            busy,
        },
        theme: { mode: themeMode, shift: modeShift },
        joining: membership.joining,
        leave: membership.leave,
        goHome: () => navigate(createPageUrl('Home')),
        scoreEntry: { ...scoreEntry, isOpen: hasEntryOpen, enteringPlayers },
        scanModels,
        host,
        chat,
        dialogs: {
            confirmation: confirmDialog,
            isGamesWonOpen,
            openGamesWon: () => setIsGamesWonOpen(true),
            closeGamesWon: () => setIsGamesWonOpen(false),
        },
    };
}
