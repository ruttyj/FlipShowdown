// Tests for the pure logic behind the Phase 4 client review fixes. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfirmDialogController } from '../src/lib/confirmDialogState.js';
import { createSharedVoteStore } from '../src/lib/voteState.js';
import {
    clearRoomPendingCards,
    listPendingRounds,
    loadPendingCards,
    planPendingRestore,
    savePendingCards,
} from '../src/lib/pendingCards.js';
import { roundMovedAction, roundMovedPrompt } from '../src/lib/gameActionOutcomes.js';
import { byeMessage, helloMessage, presentMessage, updateOtherTabs } from '../src/lib/duplicateTab.js';
import {
    addQuickSend,
    moveQuickSend,
    removeQuickSend,
    toQuickSendList,
    updateQuickSendAt,
} from '../src/lib/quickSends.js';
import { createRequestGuard } from '../src/lib/requestGuard.js';

// --- Confirm dialog ------------------------------------------------------------------

function makeController() {
    const published = [];
    const controller = createConfirmDialogController((dialog) => published.push(dialog));
    const shown = () => published[published.length - 1];
    return { controller, shown };
}

test('confirm dialog resolves confirm, cancel and dismiss', async () => {
    const { controller, shown } = makeController();

    const first = controller.ask({ title: 'A' });
    shown().onConfirm();
    assert.equal(await first, 'confirm');

    const second = controller.ask({ title: 'B' });
    shown().onCancel();
    controller.change({ ...shown(), open: false });
    assert.equal(await second, 'cancel');

    const third = controller.ask({ title: 'C' });
    controller.change({ ...shown(), open: false });
    assert.equal(await third, 'dismiss');
    assert.equal(shown().open, false);
});

test('a late close of an answered dialog does not settle or close the next one', async () => {
    const { controller, shown } = makeController();

    const first = controller.ask({ title: 'A' });
    const firstDialog = shown();
    firstDialog.onConfirm();
    assert.equal(await first, 'confirm');

    let secondAnswer = null;
    controller.ask({ title: 'B' }).then((answer) => {
        secondAnswer = answer;
    });
    // ConfirmDialog's onOpenChange(false) for dialog A, arriving after B opened.
    controller.change({ ...firstDialog, open: false });
    await Promise.resolve();

    assert.equal(secondAnswer, null);
    assert.equal(shown().title, 'B');
    assert.equal(shown().open, true);
});

test('opening a dialog over another dismisses the first', async () => {
    const { controller } = makeController();
    const first = controller.ask({ title: 'A' });
    controller.ask({ title: 'B' });
    assert.equal(await first, 'dismiss');
});

// --- Shared vote store ---------------------------------------------------------------

test('shared vote store keeps the latest state for late readers and notifies subscribers', () => {
    const store = createSharedVoteStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
        calls += 1;
    });

    store.set('r1', 't', { eligible: ['a'], holds: [{ playerId: 'a', option: 'x' }], receivedAt: 5 });

    assert.equal(calls, 1);
    const state = store.get('r1', 't');
    assert.deepEqual(state.holds, [{ playerId: 'a', option: 'x' }]);
    assert.equal(state.receivedAt, 5);
    // The same object until something changes, as useSyncExternalStore needs.
    assert.equal(store.get('r1', 't'), state);
    assert.equal(store.get('r1', 'other'), null);

    unsubscribe();
    store.set('r1', 't', { eligible: [], holds: [], receivedAt: 7 });
    assert.equal(calls, 1);
});

// --- Pending cards across rounds ------------------------------------------------------

function makeStorage() {
    const values = new Map();
    return {
        get length() {
            return values.size;
        },
        key: (index) => [...values.keys()][index] ?? null,
        getItem: (key) => (values.has(key) ? values.get(key) : null),
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: (key) => values.delete(key),
    };
}

const ENTRY = { source: 'manual', cards: [] };

test('pending rounds are listed per room, sorted, and cleared per room', () => {
    const storage = makeStorage();
    savePendingCards(storage, 'r1', 3, ENTRY);
    savePendingCards(storage, 'r1', 1, ENTRY);
    savePendingCards(storage, 'r2', 2, ENTRY);
    storage.setItem('flip7_pending_cards:r1:junk', '{}');
    storage.setItem('unrelated', 'x');

    assert.deepEqual(listPendingRounds(storage, 'r1'), [1, 3]);

    clearRoomPendingCards(storage, 'r1');
    assert.deepEqual(listPendingRounds(storage, 'r1'), []);
    assert.notEqual(loadPendingCards(storage, 'r2', 2), null);
    assert.deepEqual(listPendingRounds(null, 'r1'), []);
});

test('restore plan: host resolves older rounds, others drop them', () => {
    const base = { rounds: [1, 2, 3, 5], currentRound: 3, hasSubmittedCurrent: false };

    assert.deepEqual(planPendingRestore({ ...base, isHost: true }), {
        restoreCurrent: true,
        resolve: [1, 2],
        clear: [5],
    });
    assert.deepEqual(planPendingRestore({ ...base, isHost: false }), {
        restoreCurrent: true,
        resolve: [],
        clear: [1, 2, 5],
    });
});

test('restore plan drops the current round once it was submitted', () => {
    const plan = planPendingRestore({ rounds: [4], currentRound: 4, hasSubmittedCurrent: true, isHost: false });
    assert.deepEqual(plan, { restoreCurrent: false, resolve: [], clear: [4] });
});

// --- Round moved answers ---------------------------------------------------------------

test('dismissing the round-moved prompt keeps the cards, for host and players', () => {
    for (const isHost of [true, false]) {
        const prompt = roundMovedPrompt({ roundNumber: 2, currentRound: 3, storedScore: null, isHost });
        assert.equal(roundMovedAction(prompt, 'dismiss'), 'keep');
    }
});

test('host discards only by tapping Discard', () => {
    const prompt = roundMovedPrompt({ roundNumber: 2, currentRound: 3, storedScore: null, isHost: true });
    assert.equal(roundMovedAction(prompt, 'confirm'), 'edit');
    assert.equal(roundMovedAction(prompt, 'cancel'), 'discard');
});

// --- Duplicate tab ---------------------------------------------------------------------

test('other tabs are tracked until they say bye', () => {
    let tabs = [];
    tabs = updateOtherTabs(tabs, helloMessage('r1', 'a'), 'r1', 'me');
    tabs = updateOtherTabs(tabs, presentMessage('r1', 'b'), 'r1', 'me');
    tabs = updateOtherTabs(tabs, helloMessage('r1', 'a'), 'r1', 'me');
    assert.deepEqual(tabs, ['a', 'b']);

    tabs = updateOtherTabs(tabs, byeMessage('r1', 'a'), 'r1', 'me');
    assert.deepEqual(tabs, ['b']);

    const unchanged = updateOtherTabs(tabs, byeMessage('r2', 'b'), 'r1', 'me');
    assert.equal(unchanged, tabs);
    assert.equal(updateOtherTabs(tabs, helloMessage('r1', 'me'), 'r1', 'me'), tabs);
    assert.equal(updateOtherTabs(tabs, null, 'r1', 'me'), tabs);
});

// --- Quick sends -----------------------------------------------------------------------

test('quick sends: add dedupes and keeps the newest four', () => {
    let list = [];
    list = addQuickSend(list, { emoji: 'a', message: '' });
    list = addQuickSend(list, { emoji: 'b', message: '' });
    list = addQuickSend(list, { emoji: 'c', message: '' });
    list = addQuickSend(list, { emoji: 'a', message: '' });
    assert.deepEqual(list.map((combo) => combo.emoji), ['a', 'c', 'b']);

    list = addQuickSend(list, { emoji: 'd', message: '' });
    list = addQuickSend(list, { emoji: 'e', message: '' });
    assert.deepEqual(list.map((combo) => combo.emoji), ['e', 'd', 'a', 'c']);
});

test('quick sends: remove, move and update', () => {
    const list = [{ emoji: 'a' }, { emoji: 'b' }, { emoji: 'c' }];
    assert.deepEqual(removeQuickSend(list, 1).map((combo) => combo.emoji), ['a', 'c']);
    assert.deepEqual(moveQuickSend(list, 0, 2).map((combo) => combo.emoji), ['b', 'c', 'a']);
    assert.deepEqual(updateQuickSendAt(list, 1, { message: 'hi' })[1], { emoji: 'b', message: 'hi' });
    assert.deepEqual(list.map((combo) => combo.emoji), ['a', 'b', 'c']);
});

test('quick sends: a stored value that is not a list loads as the defaults', () => {
    assert.equal(toQuickSendList(null).length, 4);
    assert.equal(toQuickSendList({ a: 1 }).length, 4);
    assert.deepEqual(toQuickSendList([{ emoji: 'a' }]), [{ emoji: 'a' }]);
});

// --- Request guard ---------------------------------------------------------------------

test('request guard: a newer begin or an invalidate makes a task stale', () => {
    const guard = createRequestGuard();
    const first = guard.begin();
    assert.equal(first(), true);

    const second = guard.begin();
    assert.equal(first(), false);
    assert.equal(second(), true);

    guard.invalidate();
    assert.equal(second(), false);
});
