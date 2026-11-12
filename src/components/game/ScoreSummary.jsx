import React, { useEffect, useId, useRef, useState } from 'react';
import { describeScoreBreakdown } from '@/lib/flip7Scoring';
import { displayScore, spokenScore } from '@/lib/roundScores';

const KEEP_BONUS = 'keep-bonus';

/**
 * A Flip 7's choice in Brutal: keep the +15, or take 15 from a rival (X43). It starts on +15 and needs
 * a tap to change, and it is plain radios, so reaching seven cards opens no keyboard.
 *
 * @param {object} props
 * @param {{id: string, name: string}[]} props.targets  the other players
 * @param {string|null} props.chosenId  the rival, or null for +15
 * @param {(playerId: string|null) => void} props.onChoose
 */
function Flip7Chooser({ targets, chosenId, onChoose }) {
    const groupName = useId();
    const options = [{ value: KEEP_BONUS, label: 'Keep the +15', playerId: null }];
    for (const target of targets) {
        options.push({ value: target.id, label: `−15 from ${target.name}`, playerId: target.id });
    }

    return (
        <div role="radiogroup" aria-label="Flip 7: keep the bonus or take 15 from a rival" className="mt-3 text-left">
            <p className="mb-1 text-sm font-semibold text-slate-800">Flip 7! Your choice:</p>
            <div className="grid grid-cols-2 gap-2">
                {options.map((option) => (
                    <label
                        key={option.value}
                        className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm font-medium text-slate-800 has-[:checked]:border-red-600 has-[:checked]:bg-red-50 has-[:checked]:text-red-900"
                    >
                        <input
                            type="radio"
                            name={groupName}
                            checked={option.playerId === chosenId}
                            onChange={() => onChoose(option.playerId)}
                            className="shrink-0 accent-red-700"
                        />
                        <span className="min-w-0 break-words">{option.label}</span>
                    </label>
                ))}
            </div>
        </div>
    );
}

/**
 * What a screen reader is told about the Flip 7 choice, and the score it leaves.
 *
 * @param {object} choice
 * @param {boolean} choice.isNew  the chooser has only just appeared
 * @param {{id: string, name: string}[]} choice.targets
 * @param {string|null} choice.chosenId  the rival, or null for +15
 * @param {number} choice.finalScore
 */
function flip7Announcement({ isNew, targets, chosenId, finalScore }) {
    let choice = 'Keeping the +15.';
    if (chosenId !== null) {
        const rival = targets.find((target) => target.id === chosenId);
        choice = `Taking 15 from ${rival.name}.`;
    }

    const result = `${choice} Your score is ${spokenScore(finalScore)}.`;
    if (isNew) {
        return `Flip 7! You can keep the +15 or take 15 from a rival. ${result}`;
    }
    return result;
}

/**
 * A live region for the Flip 7 choice. It is empty until the chooser shows, and stays mounted, because
 * screen readers only announce a change inside a region they already know about. The text only changes
 * when the chooser appears or the choice does: the score in it is read then and left alone, so typing
 * in a card doesn't announce anything.
 */
function Flip7Announcer({ showsChooser, targets, chosenId, finalScore }) {
    const [message, setMessage] = useState('');
    const wasShowingRef = useRef(false);

    let choiceKey = null;
    if (showsChooser) {
        choiceKey = chosenId ?? KEEP_BONUS;
    }

    useEffect(() => {
        const isNew = !wasShowingRef.current;
        wasShowingRef.current = showsChooser;

        if (showsChooser) {
            setMessage(flip7Announcement({ isNew, targets, chosenId, finalScore }));
        } else {
            setMessage('');
        }
    }, [choiceKey]);

    return <p aria-live="polite" aria-atomic="true" className="sr-only">{message}</p>;
}

/**
 * The calculated round score box shown under the card list. Only duplicate number cards or
 * a declared bust are a bust here; a 0 or negative total from modifiers is a normal score (X25).
 *
 * @param {object} props
 * @param {object} props.score  from scoreHand
 * @param {string} [props.className]
 * @param {{targets: {id: string, name: string}[], chosenId: string|null, onChoose: (playerId: string|null) => void}} [props.attack]
 *        the Flip 7 chooser, shown when the hand offers it and there is someone to attack
 */
export default function ScoreSummary({ score, className = '', attack }) {
    const { isBust } = score;
    const isNegative = score.finalScore < 0;

    let label = describeScoreBreakdown(score);
    if (score.isDuplicateBust) {
        label = 'Duplicate Cards';
    } else if (isBust) {
        label = 'Bust';
    }

    const showsChooser = score.offersFlip7Attack === true && attack !== undefined && attack.targets.length > 0;

    let scoreColor = 'text-ui-accent';
    if (isBust || isNegative) {
        scoreColor = 'text-red-700';
    }

    return (
        <div className={`p-4 rounded-xl ${isBust ? 'bg-red-50' : 'bg-ui-accent-soft'} ${className}`}>
            <div className="text-center">
                <p className={`text-sm mb-1 ${isBust ? 'text-red-700 font-medium' : 'text-slate-600'}`}>
                    {label}
                </p>
                <p aria-hidden={isNegative ? 'true' : undefined} className={`text-4xl font-bold ${scoreColor}`}>
                    {displayScore(score.finalScore)}
                </p>
                {isNegative && <p className="sr-only">{spokenScore(score.finalScore)}</p>}
                {score.warnings.map((warning) => (
                    <p key={warning} className="mt-2 text-sm font-medium text-amber-800">{warning}</p>
                ))}
            </div>
            {showsChooser && (
                <Flip7Chooser targets={attack.targets} chosenId={score.flip7AttackPlayerId} onChoose={attack.onChoose} />
            )}
            <Flip7Announcer
                showsChooser={showsChooser}
                targets={attack?.targets}
                chosenId={score.flip7AttackPlayerId}
                finalScore={score.finalScore}
            />
        </div>
    );
}
