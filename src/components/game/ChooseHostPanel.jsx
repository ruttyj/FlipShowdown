import React, { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { toast } from '@/components/ui/use-toast';
import HoldToVote from '@/components/game/HoldToVote';
import { isPlayerOnline } from '@/components/game/OfflineBadge';
import { useVote } from '@/hooks/useVote';
import { formatCountdown, hostVoteStage, unlocksInMsAt } from '@/lib/voteState';

const TOPIC = 'make-host';
const TICK_MS = 1000;

const ERROR_MESSAGES = {
    invalid_option: 'That player can not be the host right now.',
};
const DEFAULT_ERROR_MESSAGE = 'The vote could not be counted. Try again.';

function namesById(players) {
    const names = {};
    for (const player of players) {
        names[player.id] = player.name;
    }
    return names;
}

/** The host's id while they are offline, otherwise null (also when the room has no host). */
function offlineHostIdOf(players, currentPlayerId) {
    const host = players.find((player) => player.is_host);
    if (!host || isPlayerOnline(host, host.id === currentPlayerId)) {
        return null;
    }
    return host.id;
}

/** Re-renders every second while `isActive`, so a countdown read from Date.now() moves. */
function useSecondTick(isActive) {
    const [, setTick] = useState(0);

    useEffect(() => {
        if (!isActive) {
            return undefined;
        }

        const timer = setInterval(() => setTick((tick) => tick + 1), TICK_MS);
        return () => {
            clearInterval(timer);
        };
    }, [isActive]);
}

/** Looks like the collapsed section, but there is nothing to open until the vote is. */
function VoteCountdown({ waitMs }) {
    return (
        <div className="mt-4 flex items-center justify-between gap-2 rounded-xl border border-slate-200 p-3 text-sm font-medium text-slate-600">
            <span>Vote for a new host</span>
            <span className="tabular-nums text-slate-400">opens in {formatCountdown(waitMs)}</span>
        </div>
    );
}

/**
 * The always-visible line of the section: label and a chevron. When `isLocked` (the vote for
 * an offline host, which stays open) it can't be collapsed.
 */
function CollapseHeader({ label, isOpen, isLocked, onToggle }) {
    return (
        <button
            type="button"
            className="flex w-full items-center justify-between gap-2 p-3 text-sm font-medium text-slate-600 disabled:cursor-default"
            aria-expanded={isOpen}
            disabled={isLocked}
            onClick={onToggle}
        >
            <span>{label}</span>
            <ChevronDown
                className={`h-4 w-4 shrink-0 text-slate-400 transition-transform duration-300 ${isOpen ? 'rotate-180' : ''}`}
                aria-hidden="true"
            />
        </button>
    );
}

function instructionText(isMeHost) {
    if (isMeHost) {
        return 'Press and hold a player for 3 seconds to make them the host.';
    }
    return 'The host is offline. Everyone press and hold the same player for 3 seconds.';
}

/**
 * "Choose a new host". The host always has it, collapsed by default, and holds a player's
 * button alone to hand the role over. The other players see nothing while the host is
 * online. When the host goes offline they see a countdown, and once the server allows a
 * vote the section is open for good: everyone online holds the same player for 3 seconds.
 * `players` carry `online` from presence.
 */
export default function ChooseHostPanel({ roomId, players, currentPlayer }) {
    const [expanded, setExpanded] = useState(false);
    const names = namesById(players);

    const { voteState } = useVote(roomId, TOPIC, {
        onPassed: (playerId) => toast({ title: `${names[playerId] ?? 'A player'} is now the host` }),
        onError: (code) => toast({ title: ERROR_MESSAGES[code] ?? DEFAULT_ERROR_MESSAGE }),
    });

    const now = Date.now();
    const stage = hostVoteStage(voteState, offlineHostIdOf(players, currentPlayer?.id), now);
    useSecondTick(stage === 'waiting');

    if (!currentPlayer) {
        return null;
    }

    const isMeHost = currentPlayer.is_host === true;
    if (!isMeHost && stage === 'hidden') {
        return null;
    }
    if (!isMeHost && stage === 'waiting') {
        return <VoteCountdown waitMs={unlocksInMsAt(voteState, now)} />;
    }

    const candidates = players.filter((player) => {
        return !player.is_host && isPlayerOnline(player, player.id === currentPlayer.id);
    });
    const isOpen = !isMeHost || expanded;

    return (
        <div className="mt-4 rounded-xl border border-slate-200">
            <CollapseHeader
                label={isMeHost ? 'Choose a new host' : 'Vote for a new host'}
                isOpen={isOpen}
                isLocked={!isMeHost}
                onToggle={() => setExpanded(!expanded)}
            />
            {/* grid-rows 0fr -> 1fr animates the height; inert keeps the closed content out of reach. */}
            <div
                className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
                aria-hidden={!isOpen}
                {...(isOpen ? {} : { inert: '' })}
            >
                <div className="overflow-hidden">
                    <div className="px-3 pb-3">
                        <h3 className="text-sm font-semibold text-slate-700">Choose a new host</h3>
                        <p className="text-xs text-slate-500 mb-2">
                            {instructionText(isMeHost)}
                        </p>
                        <div className="space-y-2">
                            {candidates.map((player) => (
                                <HoldToVote
                                    key={player.id}
                                    roomId={roomId}
                                    topic={TOPIC}
                                    option={player.id}
                                    label={player.name}
                                    myPlayerId={currentPlayer.id}
                                    holderNames={names}
                                />
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
