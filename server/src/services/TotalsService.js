import { FLIP7_POINTS } from '../../../shared/rules.js';
import { PLAYER, ROUND_SCORE } from '../domain/entities.js';

// A player's total, shared by the scoring actions and removing a player, as a score going away can
// move someone else's total (X43). Stateless: every method takes the action's RoomUnitOfWork.

export class TotalsService {
    /**
     * Sets total_score to the sum of the player's RoundScores, less 15 for every Flip 7 attack on
     * them (X43). Always a full recompute, never an increment, so a replaced or edited score can't
     * be counted twice (bug 4.3) and it doesn't matter who submitted first. Returns the updated
     * player.
     */
    recomputeTotal(work, player) {
        let total = 0;
        for (const score of work.listRoomChildren(ROUND_SCORE)) {
            if (score.player_id === player.id) {
                total += score.final_score ?? 0;
            }
            if (score.flip7_attack_player_id === player.id) {
                total -= FLIP7_POINTS;
            }
        }
        return work.updateChild(PLAYER, player, { total_score: total });
    }

    /**
     * Recomputes the player a score attacked or attacks. Nothing to do with no attack, or for a
     * target who has left the room, whose attack is ignored.
     *
     * @param {string|null|undefined} targetId  a score's flip7_attack_player_id
     */
    recomputeAttackTarget(work, targetId) {
        const target = work.listPlayers().find((player) => player.id === targetId);
        if (target) {
            this.recomputeTotal(work, target);
        }
    }
}
