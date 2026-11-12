import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Trophy, Check, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';

/** "3" -> 3; blank, negative or non-numeric input -> 0 (the server wants integers >= 0). */
function toWinCount(value) {
    const count = parseInt(value, 10);
    if (Number.isNaN(count) || count < 0) {
        return 0;
    }
    return count;
}

/**
 * Host editor for every player's games won.
 *
 * @param {object} props
 * @param {object[]} props.players
 * @param {(wins: Object<string, number>) => Promise<unknown>} props.onSave  resolves with a
 *        truthy result on success (the setGamesWon handler); the editor closes only then
 * @param {boolean} props.isSaving
 * @param {() => void} props.onClose
 */
export default function GamesWonEditor({ players, onSave, isSaving, onClose }) {
    // Only the inputs the host has touched, so a player who joins while this is open still
    // shows their current count (bug 3.11).
    const [editedWins, setEditedWins] = useState({});

    const displayedWins = (player) => editedWins[player.id] ?? String(player.games_won || 0);

    const handleSave = async () => {
        /** @type {Object<string, number>} */
        const wins = {};
        for (const player of players) {
            wins[player.id] = toWinCount(displayedWins(player));
        }

        const result = await onSave(wins);
        if (result) {
            onClose();
        }
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            // Scrolls itself because the dialog it opens in doesn't, so a long player list keeps
            // the sticky Save bar on screen.
            className="bg-white rounded-2xl px-6 pt-6 border border-slate-200 max-h-[85dvh] overflow-y-auto"
        >
            <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2 mb-4">
                <Trophy className="w-5 h-5 text-amber-500" />
                Edit Games Won
            </h3>

            <div className="space-y-3 mb-4">
                {players.map((player) => (
                    <div key={player.id} className="flex items-center gap-3">
                        <span className="text-sm font-medium text-slate-700 flex-1">{player.name}</span>
                        <Input
                            type="number"
                            min="0"
                            aria-label={`${player.name} games won`}
                            value={displayedWins(player)}
                            onChange={(e) => setEditedWins({
                                ...editedWins,
                                [player.id]: e.target.value
                            })}
                            className="w-20"
                        />
                    </div>
                ))}
            </div>

            {/* The negative margins let the frosted bar span the card's side padding. */}
            <div className="sticky bottom-0 z-10 -mx-6 px-6 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] bg-white/80 backdrop-blur border-t border-slate-200 flex flex-col-reverse sm:flex-row gap-3">
                <Button
                    onClick={onClose}
                    variant="outline"
                    className="flex-1 h-12 sm:h-auto text-base sm:text-sm"
                >
                    Cancel
                </Button>
                <Button
                    onClick={handleSave}
                    disabled={isSaving}
                    className="flex-1 h-12 sm:h-auto bg-emerald-600 hover:bg-emerald-700 text-base sm:text-sm font-semibold"
                >
                    {isSaving ? (
                        <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 mr-2 animate-spin" />
                    ) : (
                        <Check className="w-5 h-5 sm:w-4 sm:h-4 mr-2" />
                    )}
                    {isSaving ? 'Saving…' : 'Save Changes'}
                </Button>
            </div>
        </motion.div>
    );
}
