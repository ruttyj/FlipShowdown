import React from 'react';
import { displayScore } from '@/lib/roundScores';

/**
 * What a busted round shows in a score table, with the score under it when it isn't 0, as a phone only
 * has room for a narrow column between the sticky ones. Visual only: the table says what it means to
 * a screen reader, which depends on where it sits (see describeBust).
 *
 * @param {object} props
 * @param {{final_score: number}} props.score
 */
export default function BustMark({ score }) {
    return (
        <span className="font-bold text-red-700">
            BUST
            {score.final_score !== 0 && <span className="block font-medium">{displayScore(score.final_score)}</span>}
        </span>
    );
}
