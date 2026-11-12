/** Every round with a score, plus the current round so its scores can be filled in too. */
export function editableRounds(roundScores, currentRound) {
    const rounds = new Set(roundScores.map(s => s.round_number));
    rounds.add(currentRound);
    return [...rounds].sort((a, b) => a - b);
}
