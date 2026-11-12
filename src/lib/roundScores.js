// Lookups over a room's RoundScore records, kept out of the hooks so `npm test` covers them.

/** A score for showing, with a real minus sign: -6 -> "−6". Stored scores stay plain numbers. */
export function displayScore(score) {
    return String(score).replace('-', '−');
}

/** A score for a screen reader, which may skip a minus sign or read a hyphen as a dash: -6 -> "minus 6". */
export function spokenScore(score) {
    return String(score).replace('-', 'minus ');
}

/**
 * What a BUST cell says to a screen reader, since the cell itself only shows the word.
 *
 * @param {string} playerName
 * @param {{final_score: number}} score
 */
export function describeBust(playerName, score) {
    return `${playerName} busted, ${spokenScore(score.final_score)} points`;
}

function attackerName(players, attackerId) {
    const attacker = players.find((player) => player.id === attackerId);
    return attacker?.name ?? 'Someone';
}

/**
 * What a round's score cell says about the Flip 7 attacks on a player (X43): one "−15 from Sam" for
 * each, as the round's own number wouldn't add up to the total without it. The non-breaking space means
 * a narrow column breaks after the −15, not between "from" and the name. The id is the attacker's
 * score, because names aren't unique.
 *
 * @param {object[]} roundScores  the room's RoundScore records
 * @param {{id: string, name: string}[]} players
 * @param {string} playerId  the player in that row
 * @param {number} roundNumber
 * @returns {{id: string, text: string}[]}
 */
export function attackLabels(roundScores, players, playerId, roundNumber) {
    const labels = [];
    for (const score of roundScores) {
        const isAttackOnPlayer = score.flip7_attack_player_id === playerId && score.round_number === roundNumber;
        if (isAttackOnPlayer) {
            labels.push({ id: score.id, text: `−15 from\u00a0${attackerName(players, score.player_id)}` });
        }
    }
    return labels;
}

/**
 * What the target of a Flip 7 attack is told.
 *
 * @param {{id: string, name: string}[]} players
 * @param {string} attackerId
 */
export function attackToast(players, attackerId) {
    return `${attackerName(players, attackerId)} flipped 7 and took 15 points from you`;
}

/**
 * The player's saved RoundScore for a round.
 *
 * @param {object[]} roundScores  the room's RoundScore records
 * @returns {object|null} null when the player has no score saved for that round
 */
export function findStoredScore(roundScores, playerId, roundNumber) {
    return roundScores.find((score) => score.player_id === playerId && score.round_number === roundNumber) ?? null;
}
