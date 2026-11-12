// The one-tap fixes for a misread special card, and the Unlucky 7 reminder (§3.4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateFlip7Score } from '../src/lib/flip7Scoring.js';
import { applyMisreadFix, canOverrideDuplicate, handReminder, liveAttackTarget, misreadFixes, scoreHand } from '../src/lib/handFixes.js';

function numbers(...values) {
    return values.map((value) => ({ type: 'number', value: String(value) }));
}

function special(value) {
    return { type: 'special', value };
}

function fixesFor(cards, mode = 'vengeance') {
    return misreadFixes(cards, calculateFlip7Score(cards, mode), mode);
}

function fixValues(cards, mode) {
    return fixesFor(cards, mode).map((fix) => fix.value);
}

test('two plain 13s offer the Lucky 13 fix, worded as what the tap does', () => {
    const [fix] = fixesFor(numbers(13, 13, 4));

    assert.equal(fix.value, '13');
    assert.equal(fix.label, 'Change one 13 to Lucky 13');
    assert.equal(fix.announcement, 'Changed one 13 to Lucky 13.');
});

test('two plain 7s offer the Unlucky 7 fix, worded as what the tap does', () => {
    const [fix] = fixesFor(numbers(7, 7));

    assert.equal(fix.value, '7');
    assert.equal(fix.label, 'Change one 7 to Unlucky 7');
    assert.equal(fix.announcement, 'Changed one 7 to Unlucky 7.');
});

test('the Lucky 13 fix is not offered when the fixed hand would still bust', () => {
    assert.deepEqual(fixValues(numbers(13, 13, 13)), []);
    assert.deepEqual(fixValues(numbers(13, 13, 5, 5)), []);
    assert.deepEqual(fixValues(numbers(13, 13, 7, 7)), ['7']);
});

test('the Unlucky 7 fix is still offered though it leaves the hand bust, as it corrects the reading (X42)', () => {
    assert.deepEqual(fixValues(numbers(7, 7, 5, 5)), ['7']);
});

test('no fix is offered when the special card is already in the hand', () => {
    assert.deepEqual(fixesFor([special('13'), ...numbers(13, 13)]), []);
    assert.deepEqual(fixesFor([special('7'), ...numbers(7)]), []);
});

test('no fix is offered for other duplicates, a hand that did not bust, or a single 13', () => {
    assert.deepEqual(fixesFor(numbers(5, 5)), []);
    assert.deepEqual(fixesFor(numbers(13, 7)), []);
});

test('no fix is offered in a mode without the special cards', () => {
    assert.deepEqual(fixesFor(numbers(13, 13), 'classic'), []);
});

test('the Lucky 13 fix turns the first plain 13 into the special and undoes the bust', () => {
    const fixed = applyMisreadFix(numbers(4, 13, 13), '13');

    assert.deepEqual(fixed, [
        { type: 'number', value: '4' },
        special('13'),
        { type: 'number', value: '13' },
    ]);
    assert.equal(calculateFlip7Score(fixed, 'vengeance').finalScore, 30);
});

test('the Unlucky 7 fix leaves the hand bust, because the plain 7 came after it (§2)', () => {
    const fixed = applyMisreadFix(numbers(7, 7), '7');

    assert.deepEqual(fixed, [special('7'), { type: 'number', value: '7' }]);
    assert.equal(calculateFlip7Score(fixed, 'vengeance').isDuplicateBust, true);
});

// --- The Steal or Swap override (X45) ----------------------------------------

test('the override is offered for a duplicate in Vengeance', () => {
    assert.equal(canOverrideDuplicate(numbers(5, 5), 'vengeance'), true);
});

test('a third plain 13 can use it too, as the player vouches for the hand', () => {
    assert.equal(canOverrideDuplicate([special('13'), ...numbers(13, 13)], 'vengeance'), true);
});

test('the override is not offered without a duplicate', () => {
    assert.equal(canOverrideDuplicate(numbers(5, 6), 'vengeance'), false);
});

test('Classic has no such cards, so never offers it', () => {
    assert.equal(canOverrideDuplicate(numbers(5, 5), 'classic'), false);
});

test('with the override on, a duplicate scores and says the override applied', () => {
    const score = scoreHand(numbers(5, 5), 'vengeance', { overrideOn: true });

    assert.equal(score.isBust, false);
    assert.equal(score.finalScore, 10);
    assert.equal(score.duplicateAllowed, true);
});

test('with the override off, a duplicate is a bust', () => {
    const score = scoreHand(numbers(5, 5), 'vengeance');

    assert.equal(score.isDuplicateBust, true);
    assert.equal(score.duplicateAllowed, false);
});

test('an override left on after the duplicate has gone does nothing', () => {
    const score = scoreHand(numbers(5, 6), 'vengeance', { overrideOn: true });

    assert.equal(score.finalScore, 11);
    assert.equal(score.duplicateAllowed, false);
});

test('an override does not stop a declared bust', () => {
    const score = scoreHand(numbers(5, 5), 'vengeance', { busted: true, overrideOn: true });

    assert.equal(score.isBust, true);
    assert.equal(score.duplicateAllowed, false);
});

test('an override in Classic does nothing', () => {
    const score = scoreHand(numbers(5, 5), 'classic', { overrideOn: true });

    assert.equal(score.isDuplicateBust, true);
    assert.equal(score.duplicateAllowed, false);
});

test('a hand with Unlucky 7 and other cards gets the quiet reminder', () => {
    const reminder = 'Unlucky 7 discards the cards you had before it.';

    assert.equal(handReminder([special('7'), ...numbers(5)], 'vengeance'), reminder);
    assert.equal(handReminder([special('7'), { type: 'subtractor', value: '2' }], 'vengeance'), reminder);
});

test('a plain 7 with Unlucky 7 is explained, since no fix can undo that bust', () => {
    assert.equal(
        handReminder([special('7'), ...numbers(7)], 'vengeance'),
        'A 7 flipped after the Unlucky 7 is still a duplicate, so this hand busts.',
    );
});

test('no reminder for Unlucky 7 alone, a hand without it, or a mode without it', () => {
    assert.equal(handReminder([special('7')], 'vengeance'), null);
    assert.equal(handReminder(numbers(5, 7), 'vengeance'), null);
    assert.equal(handReminder([special('7'), ...numbers(5)], 'classic'), null);
});

// --- The Flip 7 attack (X43) -----------------------------------------------------------

test('scoreHand offers the attack only on a Flip 7 in a mode that has one', () => {
    const seven = numbers(1, 2, 3, 4, 5, 6, 7);

    assert.equal(scoreHand(seven, 'brutal').offersFlip7Attack, true);
    assert.equal(scoreHand(seven.slice(0, 6), 'brutal').offersFlip7Attack, false);
    assert.equal(scoreHand(seven, 'vengeance').offersFlip7Attack, false);
    assert.equal(scoreHand(seven, 'classic').offersFlip7Attack, false);
});

test('scoreHand with a target takes the bonus away and says who', () => {
    const seven = numbers(1, 2, 3, 4, 5, 6, 7);

    const score = scoreHand(seven, 'brutal', { attackPlayerId: 'sam' });

    assert.equal(score.bonus, 0);
    assert.equal(score.finalScore, 28);
    assert.equal(score.flip7AttackPlayerId, 'sam');
});

test('scoreHand with no target keeps the bonus', () => {
    const score = scoreHand(numbers(1, 2, 3, 4, 5, 6, 7), 'brutal');

    assert.equal(score.bonus, 15);
    assert.equal(score.flip7AttackPlayerId, null);
});

test('scoreHand drops a target when the hand or mode can\'t attack', () => {
    const seven = numbers(1, 2, 3, 4, 5, 6, 7);

    assert.equal(scoreHand(seven.slice(0, 6), 'brutal', { attackPlayerId: 'sam' }).flip7AttackPlayerId, null);
    assert.equal(scoreHand(seven, 'vengeance', { attackPlayerId: 'sam' }).flip7AttackPlayerId, null);
    assert.equal(scoreHand(seven, 'vengeance', { attackPlayerId: 'sam' }).finalScore, 43);
    assert.equal(scoreHand(seven, 'brutal', { attackPlayerId: 'sam', busted: true }).flip7AttackPlayerId, null);
});

test('scoreHand counts a Flip 7 made with the Steal or Swap override', () => {
    const hand = numbers(1, 2, 3, 4, 5, 6, 7, 7);

    assert.equal(scoreHand(hand, 'brutal').offersFlip7Attack, false);
    assert.equal(scoreHand(hand, 'brutal', { overrideOn: true }).offersFlip7Attack, true);
});

test('liveAttackTarget keeps a choice only while that player is still there', () => {
    const targets = [{ id: 'sam' }, { id: 'jo' }];

    assert.equal(liveAttackTarget('sam', targets), 'sam');
    assert.equal(liveAttackTarget('gone', targets), null);
    assert.equal(liveAttackTarget(null, targets), null);
    assert.equal(liveAttackTarget(undefined, targets), null);
});
