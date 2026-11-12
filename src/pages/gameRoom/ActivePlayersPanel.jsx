import React from 'react';
import { Button } from "@/components/ui/button";
import { CheckCircle, Crown, LogOut, X } from 'lucide-react';
import ChooseHostPanel from '@/components/game/ChooseHostPanel';
import OfflineBadge, { isPlayerOnline, OFFLINE_ROW_CLASSES, OnlineDot } from '@/components/game/OfflineBadge';

function PlayerRow({ player, isMe, canKick, onKick, isKickBusy }) {
    const isOnline = isPlayerOnline(player, isMe);

    let rowClasses = 'flex items-center justify-between gap-2 px-3 py-2 rounded-xl border';
    if (isMe) {
        rowClasses += ' bg-ui-accent-soft border-ui-accent-border';
    } else {
        rowClasses += ' bg-slate-50 border-slate-100';
    }
    if (!isOnline) {
        rowClasses += ` ${OFFLINE_ROW_CLASSES}`;
    }

    return (
        <li className={rowClasses}>
            <div className="flex items-center gap-2 min-w-0">
                <OnlineDot isOnline={isOnline} />
                {player.is_host && <Crown className="w-4 h-4 text-amber-600 flex-shrink-0" />}
                <span className="font-medium text-slate-800 truncate">
                    {player.name}
                    {isMe && <span className="text-ui-accent-vivid ml-1 text-sm">(You)</span>}
                </span>
                {!isOnline && <OfflineBadge />}
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
                {player.has_submitted_round && <CheckCircle className="w-4 h-4 text-emerald-600" />}
                {canKick && (
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onKick(player.id)}
                        disabled={isKickBusy}
                        aria-label={`Kick ${player.name}`}
                        className="h-8 w-8 text-red-500 hover:text-red-700 hover:bg-red-50"
                    >
                        <X className="w-4 h-4" />
                    </Button>
                )}
            </div>
        </li>
    );
}

/**
 * Who is in the active game: online state from presence (offline players are greyed out so
 * the host knows whom to force or remove, bugs 7.3 / 7.4), a Kick button for the host and a
 * Leave button for me. `players` come from useRoomData, with `online` merged in.
 */
export default function ActivePlayersPanel({ roomId, players, currentPlayer, isHost, kick, leave, busy }) {
    return (
        <div className="mt-6 pt-4 border-t border-slate-200">
            <h3 className="text-sm font-semibold text-slate-700 mb-2">Players</h3>
            <ul className="space-y-2">
                {players.map((player) => {
                    const isMe = player.id === currentPlayer?.id;
                    return (
                        <PlayerRow
                            key={player.id}
                            player={player}
                            isMe={isMe}
                            canKick={isHost && !isMe}
                            onKick={kick}
                            isKickBusy={busy.kick === true}
                        />
                    );
                })}
            </ul>
            <ChooseHostPanel roomId={roomId} players={players} currentPlayer={currentPlayer} />
            <Button
                onClick={leave}
                disabled={busy.leave === true}
                variant="outline"
                className="w-full mt-3 h-11 sm:h-auto border-red-200 text-red-600 hover:bg-red-50 text-sm sm:text-base"
            >
                <LogOut className="w-4 h-4 mr-2" />
                {busy.leave ? 'Leaving…' : 'Leave Game'}
            </Button>
        </div>
    );
}
