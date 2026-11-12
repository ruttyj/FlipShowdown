import React, { useEffect, useRef } from 'react';
import { Button } from "@/components/ui/button";
import { Play, X, Trophy, LogOut } from 'lucide-react';
import { motion } from 'framer-motion';
import RoomCodeDisplay from '@/components/game/RoomCodeDisplay';
import DraggablePlayerList from '@/components/game/DraggablePlayerList';
import ChooseHostPanel from '@/components/game/ChooseHostPanel';
import { floatingStacksClearance } from '@/lib/floatingStacks';
import { getRules } from '@/lib/gameRules';
import RoomHeader, { RulesFooter } from './RoomHeader';

/** @param {{game: object}} props  game is useGameRoom's result */
export default function WaitingRoomScreen({ game }) {
    const { table, host, leave, theme } = game;
    const { room, players, currentPlayer, isHost, busy } = table;
    // One player can start, to try the app out (X63).
    const isAlone = players.length === 1;

    // Entering from another page keeps its scroll position; start at the top so the code and QR show.
    // The page scrolls inside Layout's container rather than the window, so scroll this screen into view.
    const screenRef = useRef(null);
    useEffect(() => {
        screenRef.current?.scrollIntoView({ block: 'start' });
    }, []);

    return (
        <div
            ref={screenRef}
            className="min-h-screen game-screen-bg p-3 sm:p-4 py-4 sm:py-6"
            style={floatingStacksClearance()}
        >
            <div className="max-w-lg mx-auto pb-4 sm:pb-6">
                <RoomHeader room={room} themeMode={theme.mode} isHost={isHost} setGameMode={host.setGameMode} />
                
                <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="bg-white rounded-2xl sm:rounded-3xl p-3 sm:p-8 flex flex-col overflow-hidden"
                >
                    <div className="overflow-y-auto flex-1">
                        <RoomCodeDisplay roomCode={room.code}>
                            {isHost && (
                                <div className="mb-6">
                                    <Button
                                        onClick={host.start}
                                        className="w-full h-14 sm:h-16 bg-ui-start text-ui-on-start hover:bg-ui-start-hover text-lg sm:text-xl font-bold shadow-lg"
                                    >
                                        <Play className="w-5 h-5 sm:w-6 sm:h-6 mr-2" />
                                        {getRules(room.game_mode).startLabel}
                                    </Button>
                                    {isAlone && (
                                        <p className="text-center text-xs sm:text-sm text-white/70 mt-2">
                                            Just you so far. Start now to try things out.
                                        </p>
                                    )}
                                </div>
                            )}
                        </RoomCodeDisplay>
                    
                        <div className="mt-6 sm:mt-8">
                            <div className="flex items-center justify-between mb-4">
                                <h2 className="text-lg sm:text-xl font-semibold text-slate-800">Players</h2>
                                <span className="text-xs sm:text-sm text-slate-500">{players.length} joined</span>
                            </div>
                            <div className="max-h-[200px] overflow-y-auto">
                                <DraggablePlayerList 
                                    players={players} 
                                    currentPlayerId={currentPlayer?.id}
                                    isHost={isHost}
                                    onKickPlayer={host.kick}
                                    onMakeHost={host.makeHost}
                                    onReorder={(reorderedPlayers) => host.reorder(reorderedPlayers.map(player => player.id))}
                                    firstPlayerId={players.length > 0 ? [...players].sort((a, b) => a.turn_order - b.turn_order)[0]?.id : null}
                                    onSetFirstPlayer={host.setFirstPlayer}
                                    showGamesWon={true}
                                />
                            </div>
                        </div>
                    </div>

                    <div className="mt-6 sm:mt-8 space-y-2 sm:space-y-3 pt-4 sm:pt-6 border-t border-slate-200 flex-shrink-0">
                        {isHost && (
                            <>
                                <Button
                                    onClick={game.dialogs.openGamesWon}
                                    variant="outline"
                                    className="w-full h-10 sm:h-12 text-sm sm:text-base"
                                >
                                    <Trophy className="w-4 h-4 sm:w-5 sm:h-5 mr-2" />
                                    Edit Games Won
                                </Button>
                                <Button
                                    onClick={host.closeRoom}
                                    variant="outline"
                                    className="w-full h-10 sm:h-12 border-red-200 text-red-600 hover:bg-red-50 text-sm sm:text-base"
                                >
                                    <X className="w-4 h-4 sm:w-5 sm:h-5 mr-2" />
                                    Close Room
                                </Button>
                            </>
                        )}
                        {!isHost && (
                            <Button
                                onClick={leave}
                                disabled={busy.leave === true}
                                variant="outline"
                                className="w-full h-10 sm:h-12 border-red-200 text-red-600 hover:bg-red-50 text-sm sm:text-base"
                            >
                                <LogOut className="w-4 h-4 sm:w-5 sm:h-5 mr-2" />
                                {busy.leave ? 'Leaving…' : 'Leave Room'}
                            </Button>
                        )}
                        <ChooseHostPanel roomId={room.id} players={players} currentPlayer={currentPlayer} />
                    </div>
                </motion.div>
                <RulesFooter room={room} />
            </div>
        </div>
    );
}
