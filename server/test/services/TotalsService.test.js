import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { TotalsService } from '../../src/services/TotalsService.js';
import { HOST, openRoom } from './serviceFixture.js';

describe('TotalsService', () => {
    const totals = new TotalsService();
    let room;

    beforeEach(() => {
        room = openRoom();
    });

    afterEach(() => {
        room.close();
    });

    test('recomputeTotal sums the player\'s scores and takes 15 for each attack on them', () => {
        room.addScore(room.guestId, 1, { final_score: 20 });
        room.addScore(room.guestId, 2, { final_score: 5 });
        room.addScore(room.hostId, 1, { final_score: 40, flip7_attack_player_id: room.guestId });
        const work = room.workFor(HOST);

        const updated = totals.recomputeTotal(work, room.player(room.guestId));

        assert.equal(updated.total_score, 10);
        assert.equal(room.player(room.guestId).total_score, 10);
        assert.equal(room.player(room.hostId).total_score, 0, 'the attacker is not recomputed');
    });

    test('recomputeTotal counts a score without final_score as 0', () => {
        room.addScore(room.guestId, 1, { final_score: 12 });
        room.addScore(room.guestId, 2, {});

        const updated = totals.recomputeTotal(room.workFor(HOST), room.player(room.guestId));

        assert.equal(updated.total_score, 12);
    });

    test('recomputeAttackTarget recomputes a target in the room', () => {
        room.addScore(room.hostId, 1, { final_score: 40, flip7_attack_player_id: room.guestId });

        totals.recomputeAttackTarget(room.workFor(HOST), room.guestId);

        assert.equal(room.player(room.guestId).total_score, -15);
    });

    test('recomputeAttackTarget does nothing for no attack or a target who has left', () => {
        const work = room.workFor(HOST);

        totals.recomputeAttackTarget(work, null);
        totals.recomputeAttackTarget(work, undefined);
        totals.recomputeAttackTarget(work, 'gone-player');

        assert.deepEqual(work.events, []);
    });
});
