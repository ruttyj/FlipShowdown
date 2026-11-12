// The wording and filtering behind the "entering cards" indicator (X40).

/**
 * The other players entering cards this round, in `players` order, as [{ id, name, state }].
 * `entries` is the server's latest list ([{ playerId, state, round }]). It can name someone the
 * client hasn't heard has left, or a round the client has already moved on from.
 */
export function selectEnteringPlayers({ entries = [], players, currentPlayerId, round }) {
    const statesByPlayer = new Map();
    for (const entry of entries) {
        if (entry.round === round) {
            statesByPlayer.set(entry.playerId, entry.state);
        }
    }

    const entering = [];
    for (const player of players) {
        const isOtherPlayer = player.id !== currentPlayerId;
        if (isOtherPlayer && statesByPlayer.has(player.id)) {
            entering.push({ id: player.id, name: player.name, state: statesByPlayer.get(player.id) });
        }
    }
    return entering;
}

/**
 * Whether the turn card should point at the next dealer rather than the current one (X48): the deal
 * is done once anyone has started on their cards, so the table next needs to know who starts the next
 * round. When a departing dealer has passed the deal on for this round, the current player is the one
 * who deals next (X4), so the card stays on them.
 *
 * @param {object} status
 * @param {object} status.room
 * @param {object[]} status.players
 * @param {object[]} status.enteringPlayers  the others entering cards, from selectEnteringPlayers
 * @param {boolean} status.hasEntryOpen  I have the scanner or manual entry open
 */
export function isNextDealerHighlighted({ room, players, enteringPlayers, hasEntryOpen }) {
    const isDealPassedOn = room.turn_passed_round === room.current_round;
    if (isDealPassedOn) {
        return false;
    }

    return hasEntryOpen
        || enteringPlayers.length > 0
        || players.some(player => player.has_submitted_round);
}

/** The indicator's text for selectEnteringPlayers' list, or null when nobody is entering. */
export function enteringMessage(entering) {
    if (entering.length === 0) {
        return null;
    }

    if (entering.length === 1) {
        const [player] = entering;
        const activity = player.state === 'scanning' ? 'scanning' : 'entering';
        return `Hold on, ${player.name} is ${activity} cards`;
    }

    if (entering.length === 2) {
        return `Hold on, ${entering[0].name} and ${entering[1].name} are entering cards`;
    }

    return `Hold on, ${entering.length} players are entering cards`;
}
