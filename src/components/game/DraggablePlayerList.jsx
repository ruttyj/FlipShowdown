import React from 'react';
import { Crown, X, GripVertical, Play, Trophy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import OfflineBadge, { isPlayerOnline, OFFLINE_ROW_CLASSES, OnlineDot } from '@/components/game/OfflineBadge';

function rowClassesFor({ isDragging, isMe, isOnline }) {
    let classes = 'flex items-center gap-1 sm:gap-2 p-3 sm:p-4 rounded-xl mb-1.5 sm:mb-2 ';
    if (isDragging) {
        classes += 'shadow-2xl bg-white border-2 border-ui-accent-bright z-50';
    } else if (isMe) {
        classes += 'bg-ui-accent-soft border-2 border-ui-accent-border';
    } else {
        classes += 'bg-slate-50 border border-slate-100';
    }
    if (!isOnline) {
        classes += ` ${OFFLINE_ROW_CLASSES}`;
    }
    return classes;
}

/**
 * The waiting room's player list. The host can drag to reorder, set the first player, kick
 * and hand over hosting; everyone sees who is offline. `players` carry `online` from presence.
 */
export default function DraggablePlayerList({
    players,
    currentPlayerId,
    isHost = false,
    onKickPlayer = null,
    onMakeHost = null,
    onReorder = null,
    firstPlayerId = null,
    onSetFirstPlayer = null,
    showGamesWon = false,
}) {
    const sortedPlayers = [...players].sort((a, b) => a.turn_order - b.turn_order);

    const handleDragEnd = (result) => {
        if (!result.destination || !onReorder) {
            return;
        }

        const items = Array.from(sortedPlayers);
        const [reorderedItem] = items.splice(result.source.index, 1);
        items.splice(result.destination.index, 0, reorderedItem);

        onReorder(items);
    };

    return (
        <DragDropContext onDragEnd={handleDragEnd}>
            <Droppable droppableId="players">
                {(provided, snapshot) => (
                    <div
                        {...provided.droppableProps}
                        ref={provided.innerRef}
                        className={`${snapshot.isDraggingOver ? 'bg-[color-mix(in_srgb,var(--ui-accent-soft)_30%,transparent)] rounded-xl' : ''}`}
                    >
                        {sortedPlayers.map((player, index) => {
                            const isMe = player.id === currentPlayerId;
                            const isOnline = isPlayerOnline(player, isMe);
                            return (
                                <Draggable
                                    key={player.id}
                                    draggableId={player.id}
                                    index={index}
                                    isDragDisabled={!isHost}
                                >
                                    {(provided, snapshot) => (
                                        <div
                                            ref={provided.innerRef}
                                            {...provided.draggableProps}
                                            className={rowClassesFor({ isDragging: snapshot.isDragging, isMe, isOnline })}
                                            style={provided.draggableProps.style}
                                        >
                                            {isHost && (
                                                <div {...provided.dragHandleProps} className="p-2 -m-2 cursor-grab active:cursor-grabbing">
                                                    <GripVertical className="w-5 h-5 text-slate-400" />
                                                </div>
                                            )}

                                            <div className="flex items-center gap-1.5 sm:gap-3 flex-1 min-w-0">
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex items-center gap-2 min-w-0">
                                                        <OnlineDot isOnline={isOnline} />
                                                        <p className="font-medium text-slate-800 text-sm sm:text-base truncate">
                                                            {player.name}
                                                            {isMe && (
                                                                <span className="text-ui-accent-vivid ml-1 sm:ml-2 text-xs sm:text-sm">(You)</span>
                                                            )}
                                                        </p>
                                                    </div>
                                                    <div className="flex items-center gap-1 sm:gap-2 mt-0.5 sm:mt-1 flex-wrap">
                                                        {showGamesWon && (
                                                            <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                                                                player.games_won > 0
                                                                    ? 'bg-amber-100 text-amber-700'
                                                                    : 'bg-slate-200 text-slate-500'
                                                            }`}>
                                                                <Trophy className="w-3 h-3" />
                                                                <span>{player.games_won || 0}</span>
                                                            </div>
                                                        )}
                                                        {player.is_host && (
                                                            <div className="flex items-center gap-1 bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full text-xs font-medium">
                                                                <Crown className="w-3 h-3" />
                                                                <span>Host</span>
                                                            </div>
                                                        )}
                                                        {firstPlayerId === player.id && (
                                                            <div className="flex items-center gap-1 bg-ui-accent-tint text-ui-accent-strong px-2 py-0.5 rounded-full text-xs font-medium">
                                                                <Play className="w-3 h-3" />
                                                                <span>First</span>
                                                            </div>
                                                        )}
                                                        {!isOnline && <OfflineBadge />}
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
                                                {isHost && onSetFirstPlayer && (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => onSetFirstPlayer(player.id)}
                                                        aria-label={`Make ${player.name} go first`}
                                                        className={`h-7 sm:h-8 px-1.5 sm:px-2 ${firstPlayerId === player.id ? 'bg-ui-accent-soft border-ui-accent-border-strong' : ''}`}
                                                    >
                                                        <Play className="w-3 h-3" />
                                                    </Button>
                                                )}

                                                {isHost && onMakeHost && !player.is_host && (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => onMakeHost(player.id)}
                                                        className="h-7 sm:h-8 px-1.5 sm:px-2 text-xs"
                                                    >
                                                        Make host
                                                    </Button>
                                                )}

                                                {isHost && onKickPlayer && !player.is_host && (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => onKickPlayer(player.id)}
                                                        aria-label={`Kick ${player.name}`}
                                                        className="h-7 sm:h-8 px-1.5 sm:px-2 border-red-200 text-red-600 hover:bg-red-50"
                                                    >
                                                        <X className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                                                    </Button>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </Draggable>
                            );
                        })}
                        {provided.placeholder}
                    </div>
                )}
            </Droppable>
        </DragDropContext>
    );
}
