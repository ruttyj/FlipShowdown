// Tests for mapping game action errors to UI outcomes. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    classifySubmitError,
    roundMovedPrompt,
    submitWithOutcome,
    retractMovedPrompt,
    roundMovedAction,
    toScorePayload,
    treatCodesAsDone,
} from '../src/lib/gameActionOutcomes.js';

function makeError(status, data) {
    const error = new Error(data?.message ?? 'failed');
    error.status = status;
    error.data = data;
    return error;
}

// --- classifySubmitError -----------------------------------------------------

test('round_mismatch becomes round_moved with the server details', () => {
    const storedScore = { final_score: 0, cards: [] };
    const error = makeError(409, { code: 'round_mismatch', current_round: 4, stored_score: storedScore });

    assert.deepEqual(classifySubmitError(error), { kind: 'round_moved', currentRound: 4, storedScore });
});

test('round_mismatch without details fills in nulls', () => {
    const error = makeError(409, { code: 'round_mismatch' });

    assert.deepEqual(classifySubmitError(error), { kind: 'round_moved', currentRound: null, storedScore: null });
});

test('wrong_status finished counts as finished', () => {
    const error = makeError(409, { code: 'wrong_status', status: 'finished' });

    assert.deepEqual(classifySubmitError(error), { kind: 'finished' });
});

test('other errors are real failures', () => {
    const cases = [
        makeError(409, { code: 'wrong_status', status: 'waiting' }),
        makeError(400, { code: 'bad_request' }),
        makeError(403, { code: 'not_member' }),
        makeError(500, undefined),
        new Error('network'),
        undefined,
    ];
    for (const error of cases) {
        assert.equal(classifySubmitError(error), null);
    }
});

// --- submitWithOutcome -------------------------------------------------------

test('a 200 is saved, including already_applied', async () => {
    const response = { room: {}, players: [], already_applied: true };

    assert.deepEqual(await submitWithOutcome(async () => response), { kind: 'saved', response });
});

test('expected conflicts resolve instead of rejecting', async () => {
    const outcome = await submitWithOutcome(async () => {
        throw makeError(409, { code: 'wrong_status', status: 'finished' });
    });

    assert.deepEqual(outcome, { kind: 'finished' });
});

test('real failures still reject', async () => {
    const error = makeError(500, { code: 'oops' });

    await assert.rejects(submitWithOutcome(async () => {
        throw error;
    }), error);
});

// --- treatCodesAsDone ------------------------------------------------------

test('listed codes count as done', async () => {
    const result = await treatCodesAsDone(async () => {
        throw makeError(404, { code: 'player_not_found' });
    }, ['player_not_found']);

    assert.deepEqual(result, { alreadyDone: true, code: 'player_not_found' });
});

test('success passes through and other codes reject', async () => {
    assert.equal(await treatCodesAsDone(async () => 'ok', ['player_not_found']), 'ok');

    const error = makeError(403, { code: 'not_host' });
    await assert.rejects(treatCodesAsDone(async () => {
        throw error;
    }, ['player_not_found']), error);
});

// --- retractMovedPrompt ----------------------------------------------------

test('the retract prompt says the score stands and offers the score editor', () => {
    const prompt = retractMovedPrompt({ roundNumber: 2, currentRound: 3, storedScore: { final_score: 24 } });

    assert.match(prompt.description, /Round 2 has closed/);
    assert.match(prompt.description, /Your saved score for that round is 24/);
    assert.equal(prompt.confirmText, 'Edit round 2');
    assert.equal(prompt.confirmAction, 'edit');
    assert.equal(prompt.cancelAction, 'keep');
    assert.equal(prompt.dismissAction, 'keep');
    assert.equal(roundMovedAction(prompt, 'confirm'), 'edit');
    assert.equal(roundMovedAction(prompt, 'cancel'), 'keep');
});

// --- toScorePayload ----------------------------------------------------------

test('score payload carries the mode it was scored under, when given one (X41)', () => {
    const payload = toScorePayload(1, { cards: [], baseSum: 0, finalScore: 0 }, 'vengeance');

    assert.equal(payload.game_mode, 'vengeance');
});

test('score payload says when a score is a bust or a duplicate was allowed (X45)', () => {
    const busted = toScorePayload(1, { cards: [], baseSum: 0, finalScore: 0, isBust: true });
    const allowed = toScorePayload(1, { cards: [], baseSum: 10, finalScore: 10, isBust: false, duplicateAllowed: true });

    assert.equal(busted.busted, true);
    assert.equal(busted.duplicate_allowed, undefined);
    assert.equal(allowed.duplicate_allowed, true);
    assert.equal(allowed.busted, undefined);
});

test('a mode_changed conflict is its own outcome (X41)', () => {
    const conflict = makeError(409, { code: 'mode_changed', game_mode: 'vengeance' });

    assert.deepEqual(classifySubmitError(conflict), { kind: 'mode_changed', gameMode: 'vengeance' });
});

test('a card of type special survives the score payload (X42)', () => {
    const payload = toScorePayload(1, { cards: [{ type: 'special', value: '13' }], baseSum: 13, finalScore: 13 });

    assert.deepEqual(payload.cards, [{ value: '13', type: 'special' }]);
});

test('score payload keeps only value and type, as strings', () => {
    const payload = toScorePayload(3, {
        cards: [{ value: 7, type: 'number', id: 'x' }, { value: 'x2', type: 'modifier' }, {}],
        baseSum: 7,
        finalScore: 14,
    });

    assert.deepEqual(payload, {
        round_number: 3,
        cards: [{ value: '7', type: 'number' }, { value: 'x2', type: 'modifier' }, { value: '', type: 'number' }],
        base_sum: 7,
        final_score: 14,
    });
});

// --- roundMovedPrompt --------------------------------------------------------

test('host prompt offers the editor for the old round', () => {
    const prompt = roundMovedPrompt({ roundNumber: 3, currentRound: 4, storedScore: { final_score: 0 }, isHost: true });

    assert.equal(prompt.confirmAction, 'edit');
    assert.equal(prompt.cancelAction, 'discard');
    assert.equal(prompt.confirmText, 'Edit round 3');
    assert.match(prompt.description, /round 3/);
    assert.match(prompt.description, /now on round 4/);
    assert.match(prompt.description, /saved score for that round is 0/);
});

test('player prompt can only discard or keep', () => {
    const prompt = roundMovedPrompt({ roundNumber: 2, currentRound: null, storedScore: null, isHost: false });

    assert.equal(prompt.confirmAction, 'discard');
    assert.equal(prompt.cancelAction, 'keep');
    assert.match(prompt.description, /has moved on/);
    assert.match(prompt.description, /No score was saved/);
});

// --- The Flip 7 attack (X43) -----------------------------------------------------------

test('toScorePayload sends the Flip 7 target, and leaves it out with none', () => {
    const score = { cards: [], baseSum: 28, finalScore: 28 };

    assert.equal(toScorePayload(1, { ...score, flip7AttackPlayerId: 'sam' }).flip7_attack_player_id, 'sam');
    assert.equal('flip7_attack_player_id' in toScorePayload(1, score), false);
    assert.equal('flip7_attack_player_id' in toScorePayload(1, { ...score, flip7AttackPlayerId: null }), false);
});
