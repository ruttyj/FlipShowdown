import React from 'react';
import { Button } from "@/components/ui/button";
import { Check, Loader2 } from 'lucide-react';
import { useHandEntry } from '@/hooks/useHandEntry';
import CardListEditor from './CardListEditor';
import HandNotes from './HandNotes';
import ScoreSummary from './ScoreSummary';
import ScoreEntryPanel from './ScoreEntryPanel';
import TooManyCardsAlert from './TooManyCardsAlert';

/**
 * @param {object} props
 * @param {object[]} [props.initialCards]  cards restored from an interrupted entry
 * @param {boolean} [props.initialDuplicateAllowed]  the Steal or Swap override of restored cards
 * @param {string|null} [props.initialAttackPlayerId]  the Flip 7 choice of restored cards
 * @param {{id: string, name: string}[]} [props.attackTargets]  the other players, for the Flip 7 choice
 * @param {(cards: object[]) => void} [props.onCardsChange]  called on every change, to save a draft
 * @param {(checked: boolean) => void} [props.onDuplicateAllowedChange]  the same, for the override
 * @param {(playerId: string|null) => void} [props.onAttackChange]  the same, for the Flip 7 choice
 * @param {(result: object) => void} props.onScoreConfirmed  receives the counted cards and their score
 * @param {boolean} [props.isSubmitting]
 * @param {() => void} props.onCancel
 * @param {string} [props.gameMode]  the room's mode. The score follows it live, so a switch by the
 *        host re-scores the same cards.
 * @param {number} [props.maxScore]  the room's target, for the rules sheet
 */
export default function ManualScoreEntry({ initialCards, initialDuplicateAllowed = false, initialAttackPlayerId = null, attackTargets = [], onCardsChange, onDuplicateAllowedChange, onAttackChange, onScoreConfirmed, isSubmitting = false, onCancel, gameMode, maxScore }) {
    const hand = useHandEntry({
        start: {
            cards: initialCards,
            duplicateAllowed: initialDuplicateAllowed,
            attackPlayerId: initialAttackPlayerId,
            startsWithBlankRow: true,
        },
        gameMode,
        attackTargets,
        onCardsChange,
        onDuplicateAllowedChange,
        onAttackChange,
    });

    return (
        <ScoreEntryPanel
            title="Enter Cards"
            onBack={onCancel}
            backDisabled={isSubmitting}
            gameMode={gameMode}
            maxScore={maxScore}
            footer={
                <Button
                    onClick={() => onScoreConfirmed(hand.confirmedHand)}
                    disabled={!hand.canConfirm || isSubmitting}
                    className="w-full h-12 bg-emerald-600 hover:bg-emerald-700"
                >
                    {isSubmitting ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                        <Check className="w-4 h-4 mr-2" />
                    )}
                    {isSubmitting ? 'Submitting…' : 'Confirm Score'}
                </Button>
            }
        >
            <CardListEditor
                cards={hand.cards}
                onCardsChange={hand.setCards}
                gameMode={gameMode}
                autoFocusOnMount
            />

            <ScoreSummary
                score={hand.score}
                attack={{ targets: attackTargets, chosenId: hand.attackPlayerId, onChoose: hand.setAttack }}
            />
            <HandNotes
                cards={hand.countedCards}
                score={hand.score}
                gameMode={gameMode}
                onCardsChange={hand.setCards}
                duplicateAllowed={hand.overrideOn}
                onDuplicateAllowedChange={hand.setOverride}
            />

            {hand.hasTooManyCards && <TooManyCardsAlert />}
        </ScoreEntryPanel>
    );
}
