import React from 'react';
import { Button } from "@/components/ui/button";
import { AlertTriangle, LogOut, Play, RotateCcw, X, Trophy } from 'lucide-react';
import { motion } from 'framer-motion';
import Scoreboard from '@/components/game/Scoreboard';
import { floatingStacksClearance } from '@/lib/floatingStacks';
import RoomHeader, { RulesFooter } from './RoomHeader';

/** @param {{game: object}} props  game is useGameRoom's result */
export default function FinishedScreen({ game }) {
    const { table, host, leave, theme } = game;
    const { room, players, roundScores, currentPlayer, isHost, busy } = table;

    // Both come from the server's record of how the game finished, so they stay right when
    // scores are edited afterwards (bug 3.9).
    const winner = players.find((player) => player.id === room.winner_player_id);
    const gameWasManuallyEnded = room.finish_reason === 'ended';

    return (
        <div
            className="min-h-screen game-screen-bg p-3 sm:p-6 py-4 sm:py-8"
            style={floatingStacksClearance()}
        >
            <div className="max-w-lg mx-auto">
                <RoomHeader room={room} themeMode={theme.mode} isHost={isHost} roundScores={roundScores} />
                
                <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="bg-white rounded-2xl sm:rounded-3xl p-3 sm:p-8"
                >
                    <motion.div
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        className="text-center mb-6"
                    >
                        {gameWasManuallyEnded ? (
                            <>
                                <AlertTriangle className="w-20 h-20 text-amber-500 mx-auto mb-4" />
                                <h1 className="text-3xl font-bold text-slate-900 mb-2">Game Canceled!</h1>
                                <p className="text-xl text-slate-700">
                                    This game was ended early by the host.
                                </p>
                            </>
                        ) : (
                            <>
                                <Trophy className="w-20 h-20 text-ui-accent mx-auto mb-4" />
                                <h1 className="text-3xl font-bold text-slate-900 mb-2">Game Over!</h1>
                                {/* The winner may have left the room since, or none was recorded. */}
                                {winner ? (
                                    <p className="text-xl text-slate-700">
                                        <span className="font-semibold text-ui-accent">{winner.name}</span> wins!
                                    </p>
                                ) : (
                                    <p className="text-xl text-slate-700">Thanks for playing!</p>
                                )}
                            </>
                        )}
                    </motion.div>

                    <Scoreboard 
                        players={players} 
                        currentRound={room.current_round}
                        roundScores={roundScores}
                        currentPlayerId={currentPlayer?.id}
                    />

                    {!isHost && (
                        <div className="mt-8 flex items-center justify-center gap-2 text-sm text-slate-500">
                            <span className="h-2 w-2 rounded-full bg-ui-accent-bright animate-pulse" aria-hidden="true" />
                            <span>Waiting for the host to start a new game…</span>
                        </div>
                    )}

                    <div className="mt-8 space-y-3 pt-6 border-t border-slate-200">
                        {isHost && (
                            <>
                                <Button
                                    onClick={host.playAgain}
                                    className="w-full h-12 bg-ui-start text-ui-on-start hover:bg-ui-start-hover"
                                >
                                    <Play className="w-5 h-5 mr-2" />
                                    Play Again
                                </Button>
                                <Button
                                    onClick={game.dialogs.openGamesWon}
                                    variant="outline"
                                    className="w-full"
                                >
                                    <Trophy className="w-5 h-5 mr-2" />
                                    Edit Games Won
                                </Button>
                                <Button
                                    onClick={host.reopenGame}
                                    disabled={busy.reopenGame === true}
                                    variant="outline"
                                    className="w-full"
                                >
                                    <RotateCcw className="w-5 h-5 mr-2" aria-hidden="true" />
                                    Reopen Game
                                </Button>
                            </>
                        )}
                        <Button
                            onClick={game.goHome}
                            variant="outline"
                            className="w-full h-12"
                        >
                            Back to Home
                        </Button>
                        {!isHost && (
                            <Button
                                onClick={leave}
                                disabled={busy.leave === true}
                                variant="outline"
                                className="w-full border-red-200 text-red-600 hover:bg-red-50"
                            >
                                <LogOut className="w-5 h-5 mr-2" />
                                {busy.leave ? 'Leaving…' : 'Leave room'}
                            </Button>
                        )}
                        {isHost && (
                            <Button
                                onClick={host.deleteRoom}
                                variant="outline"
                                className="w-full border-red-200 text-red-600 hover:bg-red-50"
                            >
                                <X className="w-5 h-5 mr-2" />
                                Delete Room & Data
                            </Button>
                        )}
                    </div>
                </motion.div>
                <RulesFooter room={room} />
            </div>
        </div>
    );
}
