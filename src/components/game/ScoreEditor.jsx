import React, { useId, useState } from 'react';
import { Button } from "@/components/ui/button";
import { X, Check, Edit3 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Switch } from '@/components/ui/switch';
import { useHandEntry } from '@/hooks/useHandEntry';
import { toScorePayload } from '@/lib/gameActionOutcomes';
import { editableRounds } from '@/lib/editableRounds';
import { getRules } from '@/lib/gameRules';
import { attackLabels, spokenScore } from '@/lib/roundScores';
import AttackMarks from './AttackMarks';
import BustMark from './BustMark';
import CardListEditor from './CardListEditor';
import HandNotes, { DuplicateOverrideSwitch } from './HandNotes';
import ScoreSummary from './ScoreSummary';
import TooManyCardsAlert from './TooManyCardsAlert';

/** How a stored score opens in the editor. A player with no score for the round opens an empty hand. */
function handStartFromScore(score) {
    return {
        cards: score?.cards,
        busted: score?.busted === true,
        duplicateAllowed: score?.duplicate_allowed === true,
        attackPlayerId: score?.flip7_attack_player_id ?? null,
    };
}

function BustSwitch({ checked, onCheckedChange }) {
    const switchId = useId();

    return (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
            <label htmlFor={switchId} className="text-sm font-medium text-slate-700">Bust</label>
            <Switch id={switchId} checked={checked} onCheckedChange={onCheckedChange} />
        </div>
    );
}

function ScoreGridValue({ score }) {
    if (!score) {
        return <span className="text-slate-400">-</span>;
    }
    if (score.busted === true) {
        return <BustMark score={score} />;
    }
    return <span>{score.final_score}</span>;
}

/** The grid's button: its name says a bust out loud, as the visible BUST is inside it (X45). */
function ScoreGridButton({ score, playerName, round, onClick }) {
    let accessibleName = `Edit round ${round} score for ${playerName}`;
    if (score?.busted === true) {
        accessibleName += ` (busted, ${spokenScore(score.final_score)} points)`;
    }

    return (
        <button
            type="button"
            aria-label={accessibleName}
            onClick={onClick}
            className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-ui-accent-tint hover:text-ui-accent-strong transition-colors font-medium inline-flex items-center gap-1"
        >
            <ScoreGridValue score={score} />
            <Edit3 className="w-3 h-3 opacity-50" />
        </button>
    );
}

/**
 * Host score editor, shown while the room is in edit mode.
 *
 * @param {object} props
 * @param {object[]} props.players
 * @param {object[]} props.roundScores
 * @param {object} props.room
 * @param {{player_id: string, round_number: number, cards: object[], busted?: boolean, duplicate_allowed?: boolean, flip7_attack_player_id?: string}|null} props.initialEdit
 *        a score to open straight away (a player's late score for a closed round)
 * @param {(score: object) => Promise<unknown>} props.onSaveScore  the editScore handler; resolves
 *        truthy on success
 * @param {boolean} props.isSaving
 * @param {() => void} props.onClose  turns edit mode off
 * @param {boolean} props.isClosing
 */
export default function ScoreEditor({ players, roundScores, room, initialEdit, onSaveScore, isSaving, onClose, isClosing }) {
    // Every score in a room was scored under its current mode, since the mode locks at the first one.
    const gameMode = getRules(room.game_mode).id;
    // { playerId, roundNumber } of the score being edited, or null for the grid.
    const [editingScore, setEditingScore] = useState(() => {
        if (!initialEdit) {
            return null;
        }
        return { playerId: initialEdit.player_id, roundNumber: initialEdit.round_number };
    });
    // A score can attack anyone but its own player, who may not be the host using this editor.
    const attackTargets = players.filter((player) => player.id !== editingScore?.playerId);
    // An empty list is valid here and saves a 0 score.
    const hand = useHandEntry({
        start: handStartFromScore(initialEdit),
        gameMode,
        attackTargets,
        allowsEmptyHand: true,
    });

    const playedRounds = editableRounds(roundScores, room.current_round);
    const sortedPlayers = [...players].sort((a, b) => b.total_score - a.total_score);

    const startEditingScore = (playerId, roundNumber) => {
        const score = roundScores.find(s => s.player_id === playerId && s.round_number === roundNumber);
        setEditingScore({ playerId, roundNumber });
        hand.load(handStartFromScore(score));
    };

    const cancelEditing = () => {
        setEditingScore(null);
        hand.load();
    };

    // The server upserts the score, recomputes the total and, for the current round, marks
    // the player as submitted.
    const saveEditedScore = async () => {
        if (!editingScore) {
            return;
        }

        const { playerId, roundNumber } = editingScore;
        const payload = toScorePayload(roundNumber, hand.confirmedHand, gameMode);
        const result = await onSaveScore({ player_id: playerId, ...payload });
        if (!result) {
            return;
        }

        cancelEditing();
    };

    const showsScore = hand.cards.length > 0 || hand.isBustOn;

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-4"
        >
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                <p className="text-amber-800 font-medium text-sm">Edit Mode Active</p>
                <p className="text-amber-600 text-xs">Other players can see you're editing</p>
            </div>

            <AnimatePresence mode="wait">
                {editingScore ? (
                    <motion.div
                        key="editing"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        className="bg-white rounded-2xl p-3 sm:p-4 border-2 border-ui-accent-border"
                    >
                        <div className="mb-4">
                            <h3 className="font-semibold text-slate-800 mb-1">
                                Editing: {sortedPlayers.find(p => p.id === editingScore.playerId)?.name}
                            </h3>
                            <p className="text-sm text-slate-500">Round {editingScore.roundNumber}</p>
                        </div>

                        <div className="mb-4 space-y-2">
                            <BustSwitch checked={hand.isBustOn} onCheckedChange={hand.setBust} />
                            {hand.offersOverride && (
                                <DuplicateOverrideSwitch checked={hand.overrideOn} onCheckedChange={hand.setOverride} />
                            )}
                        </div>

                        <div className="mb-4">
                            <h4 className="font-medium text-slate-700 mb-2">Cards</h4>
                            <CardListEditor 
                                cards={hand.cards}
                                onCardsChange={hand.setCards}
                                gameMode={gameMode}
                            />
                        </div>

                        {showsScore && (
                            <div className="mb-4 space-y-3">
                                <ScoreSummary
                                    score={hand.score}
                                    attack={{ targets: attackTargets, chosenId: hand.attackPlayerId, onChoose: hand.setAttack }}
                                />
                                <HandNotes
                                    cards={hand.countedCards}
                                    score={hand.score}
                                    gameMode={gameMode}
                                    onCardsChange={hand.setCards}
                                />
                            </div>
                        )}

                        {hand.hasTooManyCards && (
                            <div className="mb-4">
                                <TooManyCardsAlert />
                            </div>
                        )}

                        {/* Sticks to the bottom of the screen so Save stays reachable on a long
                            card list. The negative margins let the frosted bar span the padding. */}
                        <div className="sticky bottom-0 z-10 -mx-3 -mb-3 sm:-mx-4 sm:-mb-4 px-3 sm:px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] rounded-b-2xl bg-white/80 backdrop-blur flex flex-col-reverse sm:flex-row gap-3">
                            <Button
                                variant="outline"
                                onClick={cancelEditing}
                                className="flex-1 h-12 sm:h-auto text-base sm:text-sm"
                            >
                                <X className="w-5 h-5 sm:w-4 sm:h-4 mr-2" />
                                Cancel
                            </Button>
                            <Button
                                onClick={saveEditedScore}
                                disabled={!hand.canConfirm || isSaving}
                                className="flex-1 h-12 sm:h-auto bg-emerald-600 hover:bg-emerald-700 text-base sm:text-sm font-semibold"
                            >
                                <Check className="w-5 h-5 sm:w-4 sm:h-4 mr-2" />
                                {isSaving ? 'Saving…' : 'Save'}
                            </Button>
                        </div>
                    </motion.div>
                ) : (
                    <motion.div
                        key="grid"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        className="bg-white rounded-2xl border border-slate-200 overflow-hidden"
                    >
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead className="bg-slate-50 border-b border-slate-200">
                                    <tr>
                                        <th className="text-left p-3 font-semibold text-slate-700 sticky left-0 bg-slate-50 z-10 min-w-[120px]">Player</th>
                                        {playedRounds.map(round => (
                                            <th key={round} className="text-center p-3 font-semibold text-slate-700 min-w-[80px]">
                                                R{round}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                    {sortedPlayers.map((player) => (
                                        <tr key={player.id} className="hover:bg-slate-50">
                                            <td className="p-3 sticky left-0 bg-white hover:bg-slate-50 z-10 min-w-[120px]">
                                                <p className="font-medium text-slate-800 truncate">{player.name}</p>
                                            </td>
                                            {playedRounds.map(round => {
                                                const score = roundScores.find(s => s.player_id === player.id && s.round_number === round);
                                                return (
                                                    <td key={round} className="text-center p-3">
                                                        <ScoreGridButton
                                                            score={score}
                                                            playerName={player.name}
                                                            round={round}
                                                            onClick={() => startEditingScore(player.id, round)}
                                                        />
                                                        <AttackMarks labels={attackLabels(roundScores, players, player.id, round)} />
                                                    </td>
                                                );
                                            })}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {!editingScore && (
                <Button 
                    variant="outline" 
                    onClick={onClose}
                    disabled={isClosing}
                    className="w-full h-12 sm:h-auto text-base sm:text-sm font-semibold"
                >
                    <Check className="w-5 h-5 sm:w-4 sm:h-4 mr-2" />
                    Done Editing
                </Button>
            )}
        </motion.div>
    );
}