import React from 'react';
import { Dialog, DialogContent } from "@/components/ui/dialog";
import GamesWonEditor from '@/components/game/GamesWonEditor';
import ConfirmDialog from '@/components/ui/ConfirmDialog';

/**
 * The dialogs every screen of a joined room shares, mounted once above them, so a change of screen
 * doesn't remount one that is open.
 *
 * @param {{game: object}} props  game is useGameRoom's result
 */
export default function RoomDialogs({ game }) {
    const { dialogs, table, host } = game;
    const { confirmation } = dialogs;

    return (
        <>
            <ConfirmDialog
                open={confirmation.open}
                onOpenChange={confirmation.onOpenChange}
                title={confirmation.title}
                description={confirmation.description}
                confirmText={confirmation.confirmText}
                cancelText={confirmation.cancelText}
                onConfirm={confirmation.onConfirm}
                onCancel={confirmation.onCancel}
                variant={confirmation.variant}
            />

            {/* The only Games Won editor in the game; it used to render inline too (bug 3.11). */}
            <Dialog open={dialogs.isGamesWonOpen} onOpenChange={dialogs.closeGamesWon}>
                <DialogContent className="max-w-md p-0">
                    <GamesWonEditor
                        players={table.players}
                        onSave={host.setGamesWon}
                        isSaving={table.busy.setGamesWon === true}
                        onClose={dialogs.closeGamesWon}
                    />
                </DialogContent>
            </Dialog>
        </>
    );
}
