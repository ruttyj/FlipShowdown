import { toast } from 'sonner';
import { game } from '@/api/game';
import { createPageUrl } from '@/utils';
import { treatCodesAsDone } from '@/lib/gameActionOutcomes';
import { getRules } from '@/lib/gameRules';
import { idsWithPlayerFirst } from '@/lib/turnOrder';

/**
 * Host-only room actions. Every write goes through a server action (src/api/game.js); the
 * server owns round advance, finishing, games won and resets.
 *
 * Each handler resolves with the action response, `{ alreadyDone: true }` when a repeat
 * found the work already done, or undefined when it failed, was cancelled at the confirm
 * prompt, or isn't allowed for this client.
 *
 * @param {object} context
 * @param {object|null} context.room
 * @param {object[]} context.players  sorted by turn order
 * @param {boolean} context.isHost
 * @param {Function} context.perform  from useActionRunner
 * @param {(options: object) => Promise<boolean>} context.confirm  from useConfirmDialog
 * @param {Function} context.navigate
 */
export function useHostActions({ room, players, isHost, perform, confirm, navigate }) {
    const canAct = Boolean(room) && isHost;

    // --- Players -------------------------------------------------------------

    const kick = async (playerId) => {
        if (!canAct) {
            return undefined;
        }

        const confirmed = await confirm({
            title: 'Kick Player?',
            description: 'This player will be removed from the game.',
            confirmText: 'Kick Player',
            variant: 'destructive',
        });
        if (!confirmed) {
            return undefined;
        }

        // Already gone (e.g. they left meanwhile) is what we wanted.
        return perform('kick', 'Kick player', () =>
            treatCodesAsDone(() => game.kick(room.id, playerId), ['player_not_found']));
    };

    const makeHost = async (playerId) => {
        if (!canAct) {
            return undefined;
        }

        const newHost = players.find((player) => player.id === playerId);
        const confirmed = await confirm({
            title: 'Make Host?',
            description: `${newHost?.name ?? 'This player'} will become the host. You won't be able to manage the game any more.`,
            confirmText: 'Make Host',
        });
        if (!confirmed) {
            return undefined;
        }

        return perform('makeHost', 'Make host', () => game.makeHost(room.id, playerId));
    };

    /** @param {string[]} playerIds  every player's id, in the new turn order */
    const reorder = async (playerIds) => {
        if (!canAct) {
            return undefined;
        }
        return perform('reorder', 'Reorder players', () => game.reorder(room.id, playerIds));
    };

    /** Moves one player to the front of the turn order, keeping everyone else's order. */
    const setFirstPlayer = async (playerId) => {
        return reorder(idsWithPlayerFirst(players, playerId));
    };

    const setGamesWon = async (wins) => {
        if (!canAct) {
            return undefined;
        }
        return perform('setGamesWon', 'Save games won', () => game.setGamesWon(room.id, wins));
    };

    // --- Game flow -------------------------------------------------------------

    /**
     * Changes the room's mode. In the waiting room that applies at once, as hosts expect from a
     * room setting. Once playing, it changes the rules under anyone already entering cards, so it
     * asks first. The room itself only changes when the server's update arrives (§3.7).
     *
     * @param {string} gameMode
     */
    const setGameMode = async (gameMode) => {
        if (!canAct) {
            return undefined;
        }

        if (room.status === 'playing') {
            const confirmed = await confirm({
                title: `Switch to ${getRules(gameMode).label}?`,
                description: 'Anyone entering cards will have them re-scored.',
                confirmText: 'Switch',
            });
            if (!confirmed) {
                return undefined;
            }
        }

        // Counted as done so the refetch still runs, which shows the host the score that locked it.
        const result = await perform('setGameMode', 'Change game mode', () =>
            treatCodesAsDone(() => game.setGameMode(room.id, gameMode), ['mode_locked']));
        if (result?.code === 'mode_locked') {
            toast.error('Someone already scored, so the mode is locked');
        }
        return result;
    };

    const start = async () => {
        if (!canAct) {
            return undefined;
        }
        return perform('start', 'Start game', () => game.start(room.id));
    };

    const forceNextRound = async () => {
        if (!canAct) {
            return undefined;
        }

        // The round the host is looking at, so a confirm tapped after the round already
        // moved on doesn't skip the next one too.
        const roundNumber = room.current_round;
        const confirmed = await confirm({
            title: 'Force Next Round?',
            description: 'Players who haven\'t submitted will get 0 points.',
            confirmText: 'Force Next Round',
            variant: 'destructive',
        });
        if (!confirmed) {
            return undefined;
        }

        return perform('forceNextRound', 'Force next round', () =>
            treatCodesAsDone(() => game.forceNextRound(room.id, roundNumber), ['round_mismatch']));
    };

    const setEditMode = async (on) => {
        if (!canAct) {
            return undefined;
        }

        let label = 'Stop editing';
        if (on) {
            label = 'Edit scores';
        }
        return perform('setEditMode', label, () => game.setEditMode(room.id, on));
    };

    /** @param {{player_id: string, round_number: number, cards: object[], base_sum: number, final_score: number}} score */
    const editScore = async (score) => {
        if (!canAct) {
            return undefined;
        }

        // Counted as done so the refetch still runs. The editor then re-scores under the new mode,
        // and undefined keeps it open so the host can check the score and save again.
        const result = await perform('editScore', 'Save score', () =>
            treatCodesAsDone(() => game.editScore(room.id, score), ['mode_changed']));
        if (result?.code === 'mode_changed') {
            toast.info('The game mode changed, so check this score and save again');
            return undefined;
        }
        return result;
    };

    const endGame = async () => {
        if (!canAct) {
            return undefined;
        }

        const confirmed = await confirm({
            title: 'End Game Now?',
            description: 'This will finish the game for all players.',
            confirmText: 'End Game',
            variant: 'destructive',
        });
        if (!confirmed) {
            return undefined;
        }

        return perform('endGame', 'End game', () => game.endGame(room.id));
    };

    /**
     * Undoes the finish, for when the last score was wrong: the host then fixes it in the editor, and
     * Done Editing finishes the game again or carries on by the normal rules.
     */
    const reopenGame = async () => {
        if (!canAct) {
            return undefined;
        }

        let description = 'The game goes back into play so you can fix scores.';
        if (room.finish_reason === 'max_score') {
            description += ' The win is taken back until the game finishes again.';
        }
        const confirmed = await confirm({
            title: 'Reopen Game?',
            description,
            confirmText: 'Reopen Game',
        });
        if (!confirmed) {
            return undefined;
        }

        return perform('reopenGame', 'Reopen game', () => game.reopenGame(room.id));
    };

    const playAgain = async () => {
        if (!canAct) {
            return undefined;
        }

        const confirmed = await confirm({
            title: 'Play Again?',
            description: 'This will reset the game and all scores.',
            confirmText: 'Start New Game',
        });
        if (!confirmed) {
            return undefined;
        }

        return perform('playAgain', 'Play again', () => game.playAgain(room.id));
    };

    // --- Room ------------------------------------------------------------------

    const closeRoom = async () => {
        if (!canAct) {
            return undefined;
        }

        const confirmed = await confirm({
            title: 'Close Room?',
            description: 'The room closes for every player and nobody can join it any more.',
            confirmText: 'Close Room',
            variant: 'destructive',
        });
        if (!confirmed) {
            return undefined;
        }

        const result = await perform('closeRoom', 'Close room', () => game.closeRoom(room.id), { refetchAfter: false });
        if (result) {
            navigate(createPageUrl('Home'));
        }
        return result;
    };

    const deleteRoom = async () => {
        if (!canAct) {
            return undefined;
        }

        const confirmed = await confirm({
            title: 'Delete Room?',
            description: 'This will permanently delete all game data and remove all players. This action cannot be undone.',
            confirmText: 'Delete Room',
            variant: 'destructive',
        });
        if (!confirmed) {
            return undefined;
        }

        const result = await perform('deleteRoom', 'Delete room', () =>
            treatCodesAsDone(() => game.deleteRoom(room.id), ['room_not_found']), { refetchAfter: false });
        if (result) {
            navigate(createPageUrl('Home'));
        }
        return result;
    };

    return {
        kick,
        makeHost,
        reorder,
        setFirstPlayer,
        setGamesWon,
        setGameMode,
        start,
        forceNextRound,
        setEditMode,
        editScore,
        endGame,
        reopenGame,
        playAgain,
        closeRoom,
        deleteRoom,
    };
}
