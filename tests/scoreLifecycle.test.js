// The score lifecycle with no React: real server replies (tests/fixtures/serverRoom.js), and the test
// decides when the client hears about the room, by calling sync(). That makes each race a plain
// sequence of lines.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { loadPendingCards, pendingCardsScope, savePendingCards } from '../src/lib/pendingCards.js';
import { createScoreLifecycle, reachedServer } from '../src/lib/scoreLifecycle.js';
import { createServerRoom } from './fixtures/serverRoom.js';

const HAND = { cards: [{ value: '7', type: 'number' }], baseSum: 7, finalScore: 7 };
const STILL_THERE = { cards: [{ value: '9', type: 'number' }] };

// --- Harness -----------------------------------------------------------------

function createMemoryStorage() {
    const items = new Map();
    return {
        get length() {
            return items.size;
        },
        key: (index) => [...items.keys()][index] ?? null,
        getItem: (key) => items.get(key) ?? null,
        setItem: (key, value) => items.set(key, value),
        removeItem: (key) => items.delete(key),
    };
}

function toReply({ status, body }) {
    if (status === 200) {
        return body;
    }
    throw Object.assign(new Error(body.message), { status, data: body });
}

const rooms = [];

afterEach(() => {
    for (const room of rooms.splice(0)) {
        room.close();
    }
});

/**
 * A lifecycle for `me` in a real room. Nothing reaches it until `sync()`, like a client that hasn't
 * had the room update yet. `answers` is the queue for ask, and `refuse` lists the actions
 * that fail like a dropped connection.
 */
function createHarness({ players = ['p1', 'p2'], me = 'p1', gameMode, answers = [], discardNotice = false } = {}) {
    const room = createServerRoom({ players, gameMode });
    rooms.push(room);

    const harness = {
        room,
        answers: [...answers],
        refuse: new Set(),
        toasts: [],
        dismissed: [],
        asked: [],
        storage: createMemoryStorage(),
        scope: () => pendingCardsScope(room.id, room.record().game_number),
        draft: (round) => loadPendingCards(harness.storage, harness.scope(), round),
        sync() {
            lifecycle.sync(harness.facts());
        },
        facts() {
            const playersNow = room.records('Player');
            const currentPlayer = room.player(me) ?? null;
            const record = room.record();
            return {
                room: record,
                currentPlayer,
                roundScores: room.records('RoundScore'),
                isHost: record.host_player_id === currentPlayer?.id && playersNow.length > 0,
            };
        },
        toastsOf: (kind) => harness.toasts.filter((toast) => toast.kind === kind).map((toast) => toast.message),
    };

    const call = (actionName, body) => {
        if (harness.refuse.has(actionName)) {
            throw new Error('offline');
        }
        return toReply(room.act(me, actionName, body));
    };

    const recordToast = (kind) => (message, options) => {
        harness.toasts.push({ kind, message, options });
        return `toast-${harness.toasts.length}`;
    };

    const lifecycle = createScoreLifecycle({
        game: {
            submitScore: async (_roomId, payload) => call('submit-score', payload),
            retractScore: async (_roomId, round) => call('retract-score', { round_number: round }),
            setEditMode: async (_roomId, on) => call('set-edit-mode', { on }),
        },
        perform: async (_name, _label, fn) => {
            try {
                return await fn();
            } catch {
                return undefined;
            }
        },
        ask: async (options) => {
            harness.asked.push(options);
            return harness.answers.shift() ?? 'dismiss';
        },
        notify: {
            info: recordToast('info'),
            success: recordToast('success'),
            error: recordToast('error'),
            dismiss: (id) => harness.dismissed.push(id),
        },
        storage: harness.storage,
        takeDiscardNotice: () => discardNotice,
    });
    harness.lifecycle = lifecycle;
    harness.sync();
    return harness;
}

// --- The outcome type --------------------------------------------------------

describe('the outcome', () => {
    it('is saved with the server\'s real reply', async () => {
        const { lifecycle } = createHarness();

        lifecycle.openEntry('manual');
        const outcome = await lifecycle.submit(HAND);

        assert.equal(outcome.kind, 'saved');
        assert.equal(outcome.response.already_applied, false);
        assert.equal(outcome.response.round_score.final_score, 7);
    });

    it('is failed when no answer came, with the entry and draft kept for a retry', async () => {
        const harness = createHarness();
        const { lifecycle } = harness;
        harness.refuse.add('submit-score');

        lifecycle.openEntry('manual');
        lifecycle.saveDraft(HAND.cards);
        const outcome = await lifecycle.submit(HAND);

        assert.deepEqual(outcome, { kind: 'failed' });
        assert.equal(lifecycle.getState().entry.roundNumber, 1);
        assert.deepEqual(harness.draft(1).cards, HAND.cards);
    });

    it('sends a bust straight away, without asking, as its toast and panel offer Undo', async () => {
        const harness = createHarness({ gameMode: 'vengeance' });

        const outcome = await harness.lifecycle.bust();

        assert.equal(outcome.kind, 'saved');
        assert.deepEqual(harness.asked, []);
        assert.equal(harness.room.records('RoundScore')[0].busted, true);
    });

    it('is nothing_to_do with no room or no score', async () => {
        const { lifecycle } = createHarness();

        assert.deepEqual(await lifecycle.takeBack(), { kind: 'nothing_to_do' });
        assert.deepEqual(await lifecycle.addMinusCard('2'), { kind: 'nothing_to_do' });

        lifecycle.sync({ room: null, currentPlayer: null, roundScores: [], isHost: false });
        assert.deepEqual(await lifecycle.submit(HAND), { kind: 'nothing_to_do' });
        assert.deepEqual(await lifecycle.bust(), { kind: 'nothing_to_do' });
        assert.deepEqual(await lifecycle.takeBack(), { kind: 'nothing_to_do' });
    });

    it('counts as having reached the server unless it failed or sent nothing', () => {
        for (const kind of ['saved', 'round_moved', 'finished', 'mode_changed']) {
            assert.equal(reachedServer({ kind }), true);
        }
        for (const kind of ['failed', 'nothing_to_do']) {
            assert.equal(reachedServer({ kind }), false);
        }
    });
});

// --- X12 ---------------------------------------------------------------------

describe('"Score submitted!" (X12), in either order', () => {
    it('reply first, round completes: shows on the room update', async () => {
        const harness = createHarness();
        harness.room.must('p2', 'submit-score', harness.room.scoreBody(1));
        harness.sync();

        harness.lifecycle.openEntry('manual');
        await harness.lifecycle.submit(HAND);
        assert.deepEqual(harness.toastsOf('success'), []);
        harness.sync();

        assert.deepEqual(harness.toastsOf('success'), ['Score submitted!']);
    });

    it('room update first, round completes: shows on the reply', async () => {
        const harness = createHarness();
        harness.room.must('p2', 'submit-score', harness.room.scoreBody(1));
        harness.sync();
        harness.lifecycle.openEntry('manual');

        const reply = harness.lifecycle.submit(HAND);
        harness.sync();
        await reply;

        assert.deepEqual(harness.toastsOf('success'), ['Score submitted!']);
    });

    it('room update first, others still to go: a later advance says nothing', async () => {
        const harness = createHarness();
        harness.lifecycle.openEntry('manual');

        const reply = harness.lifecycle.submit(HAND);
        harness.sync();
        await reply;
        harness.room.must('p2', 'submit-score', harness.room.scoreBody(1));
        harness.sync();

        assert.deepEqual(harness.toastsOf('success'), []);
    });

    it('a score that finishes the game shows too', async () => {
        const harness = createHarness();
        harness.lifecycle.openEntry('manual');
        await harness.lifecycle.submit(HAND);

        harness.room.must('p1', 'end-game');
        harness.sync();

        assert.deepEqual(harness.toastsOf('success'), ['Score submitted!']);
    });

    it('a retract stops the wait, so a later advance says nothing', async () => {
        const harness = createHarness();
        harness.lifecycle.openEntry('manual');
        await harness.lifecycle.submit(HAND);
        harness.sync();
        harness.room.must('p1', 'submit-score', harness.room.scoreBody(1));
        harness.sync();

        await harness.lifecycle.takeBack();
        harness.room.must('p1', 'submit-score', harness.room.scoreBody(1));
        harness.room.must('p2', 'submit-score', harness.room.scoreBody(1));
        harness.sync();

        assert.deepEqual(harness.toastsOf('success'), []);
    });
});

// --- Late scores -------------------------------------------------------------

describe('a score whose round has closed', () => {
    it('a stale entry is caught before it is sent, whatever the prompt answers', async () => {
        const harness = createHarness({ answers: ['dismiss'] });
        harness.lifecycle.openEntry('manual');
        harness.lifecycle.saveDraft(HAND.cards);
        harness.room.playRound();
        harness.sync();

        const outcome = await harness.lifecycle.submit(HAND);

        assert.equal(outcome.kind, 'round_moved');
        assert.equal(outcome.currentRound, 2);
        assert.equal(outcome.storedScore.final_score, 5);
        assert.equal(harness.lifecycle.getState().entry.roundNumber, 1);
        assert.ok(harness.draft(1));
    });

    it('a guest can discard it, which closes the entry and clears the draft', async () => {
        const harness = createHarness({ me: 'p2', answers: ['confirm'] });
        harness.lifecycle.openEntry('manual');
        harness.lifecycle.saveDraft(HAND.cards);
        harness.room.must('p1', 'force-next-round', { round_number: 1 });

        const outcome = await harness.lifecycle.submit(HAND);

        assert.equal(outcome.kind, 'round_moved');
        assert.equal(harness.lifecycle.getState().entry, null);
        assert.equal(harness.draft(1), null);
        assert.equal(harness.lifecycle.getState().editorStart, null);
    });

    it('the host gets the editor on it, with the start in place before the request goes out', async () => {
        const harness = createHarness({ answers: ['confirm'] });
        const { lifecycle } = harness;
        lifecycle.openEntry('manual');
        harness.room.must('p1', 'force-next-round', { round_number: 1 });

        await lifecycle.submit(HAND);

        const start = lifecycle.getState().editorStart;
        assert.equal(start.round_number, 1);
        assert.deepEqual(start.cards, HAND.cards);
        assert.equal(harness.room.record().is_edit_mode, true);
    });

    it('the editor start goes away when edit mode can\'t be turned on', async () => {
        const harness = createHarness({ answers: ['confirm'] });
        harness.refuse.add('set-edit-mode');
        harness.lifecycle.openEntry('manual');
        harness.room.must('p1', 'force-next-round', { round_number: 1 });

        await harness.lifecycle.submit(HAND);

        assert.equal(harness.lifecycle.getState().editorStart, null);
    });

    it('the editor start goes when edit mode turns off', async () => {
        const harness = createHarness({ answers: ['confirm'] });
        harness.lifecycle.openEntry('manual');
        harness.room.must('p1', 'force-next-round', { round_number: 1 });
        await harness.lifecycle.submit(HAND);
        harness.sync();

        harness.room.must('p1', 'set-edit-mode', { on: false });
        harness.sync();

        assert.equal(harness.lifecycle.getState().editorStart, null);
    });

    it('a game that ended closes the entry', async () => {
        const harness = createHarness();
        harness.lifecycle.openEntry('scanner');
        harness.lifecycle.saveDraft(HAND.cards);
        harness.room.must('p1', 'end-game');

        const outcome = await harness.lifecycle.submit(HAND);

        assert.deepEqual(outcome, { kind: 'finished' });
        assert.equal(harness.lifecycle.getState().entry, null);
        assert.equal(harness.draft(1), null);
    });

    it('a retry after a lost reply counts as saved, even once the round has moved on', async () => {
        const harness = createHarness();
        const body = harness.room.scoreBody(1, { cards: HAND.cards, base_sum: 7, final_score: 7, game_mode: 'classic' });
        harness.room.must('p1', 'submit-score', body);
        harness.room.must('p2', 'submit-score', harness.room.scoreBody(1));

        const outcome = await harness.lifecycle.submit(HAND);

        assert.equal(outcome.kind, 'saved');
        assert.equal(outcome.response.already_applied, true);
    });
});

// --- Modes -------------------------------------------------------------------

describe('the mode changing under a score', () => {
    it('keeps the entry open and its draft', async () => {
        const harness = createHarness();
        harness.lifecycle.openEntry('manual');
        harness.lifecycle.saveDraft(HAND.cards);
        harness.room.must('p1', 'set-game-mode', { game_mode: 'vengeance' });

        const outcome = await harness.lifecycle.submit(HAND);

        assert.deepEqual(outcome, { kind: 'mode_changed', gameMode: 'vengeance' });
        assert.equal(harness.lifecycle.getState().entry.roundNumber, 1);
        assert.ok(harness.draft(1));
    });

    it('sends a bust again under the new mode', async () => {
        const harness = createHarness();
        harness.room.must('p1', 'set-game-mode', { game_mode: 'vengeance' });

        const outcome = await harness.lifecycle.bust();

        assert.equal(outcome.kind, 'saved');
        assert.equal(harness.room.records('RoundScore')[0].busted, true);
    });
});

// --- Taking back -------------------------------------------------------------

describe('taking a score back', () => {
    async function submittedHarness(options) {
        const harness = createHarness(options);
        harness.lifecycle.openEntry('manual');
        await harness.lifecycle.submit(HAND);
        harness.sync();
        return harness;
    }

    it('reopens entry on the cards', async () => {
        const harness = await submittedHarness();

        const outcome = await harness.lifecycle.takeBack();

        assert.equal(outcome.kind, 'saved');
        assert.deepEqual(outcome.response.round_score.cards, HAND.cards);
        assert.deepEqual(harness.lifecycle.getState().entry, { source: 'manual', roundNumber: 1 });
        assert.deepEqual(harness.draft(1), { source: 'manual', cards: HAND.cards });
    });

    it('a failure keeps the draft, as it may have landed', async () => {
        const harness = await submittedHarness();
        harness.refuse.add('retract-score');

        const outcome = await harness.lifecycle.takeBack();

        assert.deepEqual(outcome, { kind: 'failed' });
        assert.equal(harness.lifecycle.getState().entry, null);
        assert.ok(harness.draft(1));
    });

    it('too late drops the draft and tells a guest', async () => {
        const harness = await submittedHarness({ me: 'p2' });
        harness.room.must('p1', 'force-next-round', { round_number: 1 });

        const outcome = await harness.lifecycle.takeBack();

        assert.equal(outcome.kind, 'round_moved');
        assert.equal(harness.draft(1), null);
        assert.deepEqual(harness.toastsOf('info'), ['Round closed. Ask the host to fix it']);
    });

    it('too late offers the host the editor on the score that stands', async () => {
        const harness = await submittedHarness({ answers: ['confirm'] });
        harness.room.must('p2', 'submit-score', harness.room.scoreBody(1));

        await harness.lifecycle.takeBack();

        assert.equal(harness.asked.at(-1).confirmText, 'Edit round 1');
        assert.deepEqual(harness.lifecycle.getState().editorStart.cards, HAND.cards);
    });

    it('the host can leave it', async () => {
        const harness = await submittedHarness({ answers: ['cancel'] });
        harness.room.must('p2', 'submit-score', harness.room.scoreBody(1));

        await harness.lifecycle.takeBack();

        assert.equal(harness.lifecycle.getState().editorStart, null);
    });

    it('a finished game says who can fix it', async () => {
        const host = await submittedHarness();
        host.room.must('p1', 'end-game');
        assert.equal((await host.lifecycle.takeBack()).kind, 'finished');
        assert.deepEqual(host.toastsOf('info'), ['The game has finished. Use Reopen Game to fix this score']);

        const guest = await submittedHarness({ me: 'p2' });
        guest.room.must('p1', 'end-game');
        await guest.lifecycle.takeBack();
        assert.deepEqual(guest.toastsOf('info'), ['Round closed. Ask the host to fix it']);
    });
});

// --- The Bust tile -----------------------------------------------------------

describe('the Bust tile\'s Undo toast', () => {
    it('Undo retracts the score and opens nothing', async () => {
        const harness = createHarness();
        await harness.lifecycle.bust();
        const [{ options }] = harness.toasts;
        assert.equal(options.duration, 4000);

        const outcome = await options.action.onClick();

        assert.equal(outcome.kind, 'saved');
        assert.equal(harness.room.records('RoundScore').length, 0);
        assert.equal(harness.lifecycle.getState().entry, null);
    });

    it('is dismissed once by what makes it stale, and no id is never sent', async () => {
        const harness = createHarness();
        await harness.lifecycle.bust();
        harness.sync();

        await harness.lifecycle.takeBack();
        harness.room.must('p1', 'submit-score', harness.room.scoreBody(1));
        harness.sync();
        await harness.lifecycle.takeBack();

        assert.deepEqual(harness.dismissed, ['toast-1']);
    });

    it('doesn\'t show with minus cards, which it would lose', async () => {
        const harness = createHarness({ gameMode: 'brutal' });

        await harness.lifecycle.bust(['6']);

        assert.equal(harness.room.records('RoundScore')[0].final_score, -6);
        assert.deepEqual(harness.toasts, []);
    });
});

// --- Minus cards -------------------------------------------------------------

describe('Add a minus card', () => {
    async function bustedHarness(options) {
        const harness = createHarness({ gameMode: 'brutal', ...options });
        await harness.lifecycle.bust();
        harness.sync();
        return harness;
    }

    it('a second card before the room update builds on the first', async () => {
        const harness = await bustedHarness();

        await harness.lifecycle.addMinusCard('6');
        await harness.lifecycle.addMinusCard('4');

        assert.equal(harness.room.records('RoundScore')[0].final_score, -10);
    });

    it('a newer stored score wins, as the host may have edited it', async () => {
        const harness = await bustedHarness();
        await harness.lifecycle.addMinusCard('6');
        const [stored] = harness.room.records('RoundScore');
        const edited = { ...stored, cards: [], updated_date: '2999-01-01T00:00:00.000Z' };

        harness.lifecycle.sync({ ...harness.facts(), roundScores: [edited] });
        await harness.lifecycle.addMinusCard('2');

        assert.equal(harness.room.records('RoundScore')[0].final_score, -2);
    });

    it('Undo bust straight after keeps that card in the draft', async () => {
        const harness = await bustedHarness();
        await harness.lifecycle.addMinusCard('6');

        await harness.lifecycle.takeBack();

        assert.deepEqual(harness.draft(1).cards, [{ type: 'subtractor', value: '6' }]);
        assert.equal(harness.lifecycle.getState().entry.source, 'manual');
    });

    it('announces nothing when the round moves on later', async () => {
        const harness = createHarness({ gameMode: 'brutal' });
        await harness.lifecycle.bust();
        harness.sync();
        await harness.lifecycle.addMinusCard('6');

        harness.room.must('p2', 'submit-score', harness.room.scoreBody(1));
        harness.sync();

        assert.deepEqual(harness.toastsOf('success'), []);
    });
});

// --- Drafts ------------------------------------------------------------------

describe('drafts', () => {
    it('does nothing with no entry open', () => {
        const harness = createHarness();

        harness.lifecycle.saveDraft(HAND.cards);

        assert.equal(harness.draft(1), null);
        assert.equal(harness.lifecycle.readDraft(harness.room.record()), null);
    });

    it('keeps the override and the Flip 7 choice beside the cards, and drops them when off', () => {
        const harness = createHarness();
        const { lifecycle } = harness;
        lifecycle.openEntry('scanner');

        lifecycle.saveDuplicateAllowed(true);
        lifecycle.saveAttack('p2');
        assert.equal(harness.draft(1), null);

        lifecycle.saveDraft(HAND.cards);
        lifecycle.saveDuplicateAllowed(true);
        lifecycle.saveAttack('p2');
        lifecycle.saveDraft(HAND.cards);
        assert.deepEqual(harness.draft(1), { source: 'scanner', cards: HAND.cards, duplicateAllowed: true, flip7AttackPlayerId: 'p2' });

        lifecycle.saveDuplicateAllowed(false);
        lifecycle.saveAttack(null);
        assert.deepEqual(lifecycle.readDraft(harness.room.record()), { source: 'scanner', cards: HAND.cards });
    });

    it('switching to manual keeps the round, and with no entry does nothing', () => {
        const { lifecycle } = createHarness();

        lifecycle.switchToManualEntry();
        assert.equal(lifecycle.getState().entry, null);

        lifecycle.openEntry('scanner');
        lifecycle.switchToManualEntry();
        assert.deepEqual(lifecycle.getState().entry, { source: 'manual', roundNumber: 1 });
    });
});

// --- Room changes ------------------------------------------------------------

describe('the room changing', () => {
    it('closes the entry and clears drafts when the game ends', () => {
        const harness = createHarness();
        harness.lifecycle.openEntry('manual');
        harness.lifecycle.saveDraft(HAND.cards);

        harness.room.must('p1', 'end-game');
        harness.sync();

        assert.equal(harness.lifecycle.getState().entry, null);
        assert.equal(harness.draft(1), null);
    });

    it('closes an entry when a new game starts unseen (X5b)', () => {
        const harness = createHarness();
        harness.lifecycle.openEntry('manual');
        const facts = harness.facts();

        harness.lifecycle.sync({ ...facts, room: { ...facts.room, game_number: 2 } });

        assert.equal(harness.lifecycle.getState().entry, null);
    });

    it('tells subscribers until they leave', () => {
        const { lifecycle } = createHarness();
        let calls = 0;
        const off = lifecycle.subscribe(() => {
            calls += 1;
        });

        lifecycle.openEntry('manual');
        off();
        lifecycle.closeEntry();

        assert.equal(calls, 1);
    });
});

// --- Restoring after a reload ------------------------------------------------

describe('restoring after a reload', () => {
    function restored({ players, me, rounds = [], play = 0, answers, discardNotice }) {
        const seed = createHarness({ players, me });
        for (let index = 0; index < play; index += 1) {
            seed.room.playRound();
        }
        const lifecycle = createScoreLifecycle({
            game: {},
            perform: async (_name, _label, fn) => fn(),
            ask: async (options) => {
                seed.asked.push(options);
                return answers.shift();
            },
            notify: { info: (message) => seed.toasts.push({ kind: 'info', message }) },
            storage: seed.storage,
            takeDiscardNotice: () => discardNotice === true,
        });
        for (const round of rounds) {
            savePendingCards(seed.storage, seed.scope(), round, { source: 'scanner', ...STILL_THERE });
        }
        return { seed, lifecycle };
    }

    it('reopens the entry on the current round\'s draft, once per game', () => {
        const { seed, lifecycle } = restored({ rounds: [1], answers: [] });

        lifecycle.sync(seed.facts());
        lifecycle.closeEntry();
        lifecycle.sync(seed.facts());

        assert.equal(lifecycle.getState().entry, null);
        assert.deepEqual(seed.toastsOf('info'), ['Restored the cards you were entering']);
    });

    it('shows the discarded page notice when there is nothing to restore', () => {
        const { seed, lifecycle } = restored({ discardNotice: true, answers: [] });

        lifecycle.sync(seed.facts());

        assert.equal(seed.toasts.length, 1);
        assert.match(seed.toasts[0].message, /reloaded in the background/);
    });

    it('asks the host about an older round and clears it on discard, skipping a draft gone meanwhile', async () => {
        const { seed, lifecycle } = restored({ rounds: [1], play: 1, answers: ['cancel'] });

        lifecycle.sync(seed.facts());
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(seed.asked.length, 1);
        assert.equal(seed.draft(1), null);
    });
});
