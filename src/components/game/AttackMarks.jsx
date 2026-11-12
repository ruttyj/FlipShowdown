import React from 'react';

/**
 * The Flip 7 attacks on a player in a score table's round cell (X43): "−15 from Sam". The round's own
 * number doesn't include them, so without this the row wouldn't add up to the total. They wrap within
 * a fixed width, as a long name would otherwise push the column out from between the sticky ones: a
 * 360 px screen only has room for this width, so the label takes two lines, "−15" and "from Sam".
 *
 * @param {object} props
 * @param {{id: string, text: string}[]} props.labels  from attackLabels
 */
export default function AttackMarks({ labels }) {
    return labels.map((label) => (
        <span key={label.id} className="mx-auto block w-16 break-words text-xs font-semibold leading-tight text-red-700">
            {label.text}
        </span>
    ));
}
