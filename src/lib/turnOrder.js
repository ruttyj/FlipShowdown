/**
 * The player ids in the order to send to `reorder` so `playerId` goes first and everyone
 * else keeps their current relative order.
 *
 * @param {{id: string}[]} players  in the current turn order
 * @param {string} playerId
 * @returns {string[]}
 */
export function idsWithPlayerFirst(players, playerId) {
    const otherIds = [];
    for (const player of players) {
        if (player.id !== playerId) {
            otherIds.push(player.id);
        }
    }
    return [playerId, ...otherIds];
}
