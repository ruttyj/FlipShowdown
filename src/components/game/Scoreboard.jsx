import React, { useEffect, useRef } from 'react';
import { Trophy } from 'lucide-react';
import { attackLabels, describeBust } from '@/lib/roundScores';
import AttackMarks from './AttackMarks';
import BustMark from './BustMark';

// My row gets an accent bar (an inset shadow, since the sticky name cell would cover a row
// border), a faint tint and a "You" pill. The sticky cells keep opaque backgrounds so the
// round columns scrolling underneath don't show through.
const ROW_STYLES = {
    me: {
        row: 'bg-[color-mix(in_srgb,var(--ui-accent-soft)_70%,transparent)]',
        nameCell: 'bg-ui-accent-soft shadow-[inset_4px_0_0_0_var(--ui-accent-vivid)]',
        totalCell: 'bg-ui-accent-tint text-ui-accent-ink',
    },
    other: {
        row: 'hover:bg-slate-50',
        nameCell: 'bg-white hover:bg-slate-50',
        totalCell: 'bg-slate-50 text-slate-800',
    },
};

function YouPill() {
    return (
        <span className="px-1.5 py-0.5 rounded-full text-[10px] leading-none font-bold uppercase tracking-wide bg-ui-accent text-ui-on-accent">
            You
        </span>
    );
}

/** One round's cell: a dash with no score, BUST for a bust (X45), otherwise the plain number. */
function RoundCellContent({ playerName, score }) {
    if (!score) {
        return <span className="text-slate-300">-</span>;
    }

    if (score.busted === true) {
        return (
            <>
                <span aria-hidden="true"><BustMark score={score} /></span>
                <span className="sr-only">{describeBust(playerName, score)}</span>
            </>
        );
    }
    return <span className="text-slate-700">{score.final_score}</span>;
}

/** `currentPlayerId` is optional; the matching player's row is highlighted as mine. */
export default function Scoreboard({ players, currentRound, roundScores, currentPlayerId = null }) {
    const scrollContainerRef = useRef(null);
    const sortedPlayers = [...players].sort((a, b) => b.total_score - a.total_score);
    
    // One column per round: every round with a score, plus the current round (which has
    // no scores until someone submits, and must not appear twice once they do).
    const roundNumbers = new Set(roundScores.map(s => s.round_number));
    roundNumbers.add(currentRound);
    const playedRounds = [...roundNumbers].sort((a, b) => a - b);

    // Auto-scroll to the right when scores update. A score's value counts too, as a wider cell
    // (BUST -10 after a minus card, X43) would otherwise end up under the sticky Total column.
    const scoreValues = roundScores.map(s => s.final_score).join();
    useEffect(() => {
        if (scrollContainerRef.current && playedRounds.length > 0) {
            scrollContainerRef.current.scrollTo({
                left: scrollContainerRef.current.scrollWidth,
                behavior: 'smooth'
            });
        }
    }, [scoreValues, playedRounds.length]);

    return (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="panel-header-bg p-4 text-white">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Trophy className="w-5 h-5" />
                        <h3 className="font-semibold">Scoreboard</h3>
                    </div>
                    <span className="text-sm bg-white/20 px-3 py-1 rounded-full">
                        Round {currentRound}
                    </span>
                </div>
            </div>

            <div className="relative">
                <div ref={scrollContainerRef} className="overflow-x-auto max-h-[300px] overflow-y-auto">
                    <table className="w-full text-sm">
                        <thead className="bg-slate-50 border-b border-slate-200 sticky top-0 z-10">
                            <tr>
                                <th className="text-left p-3 font-semibold text-slate-700 sticky left-0 bg-slate-50 z-20 min-w-[120px] text-transparent">Player</th>
                                {playedRounds.map(round => (
                                    <th key={round} className={`text-center p-3 font-semibold text-slate-700 min-w-[60px] ${round === currentRound ? 'bg-ui-accent-tint' : 'bg-slate-50'}`}>
                                        R{round}
                                    </th>
                                ))}
                                <th className="text-center p-3 font-semibold sticky bg-slate-50 right-0 z-20 min-w-[80px]">Total</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {sortedPlayers.map((player, index) => {
                                const playerRoundScores = roundScores.filter(s => s.player_id === player.id);
                                const isMe = currentPlayerId !== null && player.id === currentPlayerId;
                                const styles = isMe ? ROW_STYLES.me : ROW_STYLES.other;

                                return (
                                    <tr key={player.id} className={styles.row} aria-current={isMe ? 'true' : undefined}>
                                        <td className={`p-3 sticky left-0 z-10 min-w-[120px] ${styles.nameCell}`}>
                                            <div className="flex items-center gap-2">
                                                <div className={`w-6 h-6 rounded-full flex items-center justify-center font-bold text-xs flex-shrink-0 ${
                                                    index === 0 ? 'bg-amber-100 text-amber-700' :
                                                    index === 1 ? 'bg-slate-200 text-slate-600' :
                                                    index === 2 ? 'bg-orange-100 text-orange-700' :
                                                    'bg-slate-100 text-slate-500'
                                                }`}>
                                                    {index + 1}
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-1 flex-wrap">
                                                        <span className="font-medium text-slate-800">{player.name}</span>
                                                        {isMe && <YouPill />}
                                                        <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                                                            player.games_won > 0 
                                                                ? 'bg-amber-100 text-amber-700' 
                                                                : 'bg-slate-200 text-slate-500'
                                                        }`}>
                                                            <Trophy className="w-3 h-3" />
                                                            <span>{player.games_won || 0}</span>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        </td>
                                        {playedRounds.map(round => {
                                             const score = playerRoundScores.find(s => s.round_number === round);
                                             return (
                                                 <td key={round} className={`text-center p-3 ${round === currentRound ? 'bg-ui-accent-soft' : ''}`}>
                                                     <RoundCellContent playerName={player.name} score={score} />
                                                     <AttackMarks labels={attackLabels(roundScores, players, player.id, round)} />
                                                 </td>
                                             );
                                         })}
                                         <td className={`text-center p-3 font-bold sticky right-0 z-10 min-w-[80px] ${styles.totalCell}`}>
                                             {player.total_score}
                                         </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}