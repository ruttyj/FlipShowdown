// One player's score for the round, from opening an entry screen to the score standing, taken back
// or recovered after the round closed. Everything that depends on the order things happen in lives
// here, so it can be tested without React (tests/scoreLifecycle.test.js): the room data arrives
// through sync(), the player's actions through the intents, and the outside world through ports.
//
//   const lifecycle = createScoreLifecycle(ports)
//   lifecycle.sync({ room, currentPlayer, roundScores, isHost })   // after every room change
//   lifecycle.getState()     // { entry, editorStart, enteredScoreRound }
//   lifecycle.subscribe(fn)  // fn() on every change of that state
//   await lifecycle.submit(scoreData)   // and bust, takeBack, addMinusCard: resolve a ScoreOutcome
//
// The room data and the replies to my actions race each other, in either order, so nothing here may
// assume which comes first (X12, X45).

import { calculateFlip7Score } from './flip7Scoring.js';
import { retractMovedPrompt, roundMovedAction, roundMovedPrompt, submitWithOutcome, toScorePayload } from './gameActionOutcomes.js';
import { getRules } from './gameRules.js';
import {
    clearOtherGamesPendingCards,
    clearPendingCards,
    clearRoomPendingCards,
    listPendingRounds,
    loadPendingCards,
    pendingCardsScope,
    planPendingRestore,
    savePendingCards,
} from './pendingCards.js';
import { findStoredScore } from './roundScores.js';

const UNDO_TOAST_MS = 4000;
const ROUND_CLOSED_MESSAGE = 'Round closed. Ask the host to fix it';
const GAME_FINISHED_MESSAGE = 'The game has finished. Use Reopen Game to fix this score';

/**
 * How an intent ended. Every intent resolves with one, whatever the server says.
 *
 * - `saved`: the server took it. `response` is its reply.
 * - `round_moved`: the round had closed. `currentRound` is the room's round now (null if unknown) and
 *   `storedScore` my saved score for the round I meant (null if none).
 * - `finished`: the game had ended.
 * - `mode_changed`: the host changed the mode. `gameMode` is the room's mode now.
 * - `failed`: no answer to act on: it failed (the action runner has said so, and it may still have
 *   landed) or the same action was already running.
 * - `nothing_to_do`: there was no room, player or score to act on, so nothing was sent.
 *
 * @typedef {{kind: 'saved', response: object}
 *   | {kind: 'round_moved', currentRound: number|null, storedScore: object|null}
 *   | {kind: 'finished'}
 *   | {kind: 'mode_changed', gameMode: string}
 *   | {kind: 'failed'}
 *   | {kind: 'nothing_to_do'}} ScoreOutcome
 */

/** @type {ScoreOutcome} */
const FAILED = { kind: 'failed' };
/** @type {ScoreOutcome} */
const NOTHING_TO_DO = { kind: 'nothing_to_do' };

/**
 * What the lifecycle needs from outside.
 *
 * @typedef {object} ScorePorts
 * @property {{submitScore: Function, retractScore: Function, setEditMode: Function}} game  src/api/game.js
 * @property {(name: string, label: string, fn: () => Promise<any>) => Promise<any>} perform  from
 *           useActionRunner: resolves undefined when it failed or was already running
 * @property {(options: object) => Promise<'confirm'|'cancel'|'dismiss'>} ask  from useConfirmDialog
 * @property {{info: Function, success: Function, error: Function, dismiss: Function}} notify  sonner's toast
 * @property {Storage|null} storage  where drafts are kept, null when blocked
 * @property {() => boolean} takeDiscardNotice  true the first time it's asked on a page the browser
 *           had discarded and reloaded, then false for the page's life (X21)
 */

/** True when the server answered or was at least asked: the screen has moved on from this attempt. */
export function reachedServer(outcome) {
    return outcome.kind !== 'failed' && outcome.kind !== 'nothing_to_do';
}

// --- Helpers -----------------------------------------------------------------

/**
 * The Bust tile's score: a declared bust holding only the minus cards chosen with it, worth whatever
 * a bust is in that mode.
 */
function bustScore(gameMode, minusValues) {
    const cards = minusValues.map((value) => ({ type: 'subtractor', value }));
    return { cards, ...calculateFlip7Score(cards, gameMode, { busted: true }) };
}

/**
 * The draft to save. The override and the Flip 7 choice are only stored when on, so most drafts are
 * just their cards.
 *
 * @param {'scanner'|'manual'} source
 * @param {object[]} cards
 * @param {{duplicateAllowed?: boolean, flip7AttackPlayerId?: string|null}} choices
 */
function buildDraft(source, cards, { duplicateAllowed, flip7AttackPlayerId }) {
    const draft = { source, cards };
    if (duplicateAllowed) {
        draft.duplicateAllowed = true;
    }
    if (flip7AttackPlayerId) {
        draft.flip7AttackPlayerId = flip7AttackPlayerId;
    }
    return draft;
}

function scopeOf(room) {
    if (!room) {
        return null;
    }
    return pendingCardsScope(room.id, room.game_number);
}

/** My stored score for the room's current round, or null with no room, player or score. */
function findMyCurrentScore({ room, currentPlayer, roundScores }) {
    if (!room || !currentPlayer) {
        return null;
    }
    return findStoredScore(roundScores, currentPlayer.id, room.current_round);
}

/** The editor's starting point for a score, in the stored score's field names. */
function toEditorStart(playerId, roundNumber, scoreData) {
    const start = { player_id: playerId, round_number: roundNumber, cards: scoreData.cards };
    if (scoreData.isBust) {
        start.busted = true;
    }
    if (scoreData.duplicateAllowed) {
        start.duplicate_allowed = true;
    }
    if (scoreData.flip7AttackPlayerId) {
        start.flip7_attack_player_id = scoreData.flip7AttackPlayerId;
    }
    return start;
}

// --- State -------------------------------------------------------------------

function setState(machine, changes) {
    machine.state = { ...machine.state, ...changes };
    for (const listener of [...machine.listeners]) {
        listener();
    }
}

function closeEntry(machine) {
    if (machine.state.entry !== null) {
        setState(machine, { entry: null });
    }
}

/**
 * Clears a round's draft. Only closes the entry screen when it is open for that round: a restored
 * older round can be discarded while the current round's entry stays open.
 */
function finishEntry(machine, facts, roundNumber) {
    clearPendingCards(machine.ports.storage, scopeOf(facts.room), roundNumber);
    if (machine.state.entry?.roundNumber === roundNumber) {
        closeEntry(machine);
    }
}

// --- Announcing a score that completed the round (X12) ---------------------------

/**
 * The submit reply doesn't say whether the round is complete, so the room data decides, and it may
 * already have arrived. Once my score shows as submitted with the round unchanged, others are still to
 * submit (the inline message covers that) and a later advance is not announced.
 */
function settleAwaitedRound(machine) {
    const awaitingRound = machine.awaitingRound;
    if (awaitingRound === null) {
        return;
    }

    const { room, currentPlayer } = machine.facts;
    const roundCompleted = (room?.current_round ?? null) !== awaitingRound || room?.status === 'finished';
    if (roundCompleted) {
        machine.awaitingRound = null;
        machine.ports.notify.success('Score submitted!');
        return;
    }

    if (currentPlayer?.has_submitted_round === true) {
        machine.awaitingRound = null;
    }
}

// --- Opening the editor on a closed round --------------------------------------

/**
 * The start goes in before the request, because the room can turn edit mode on (and mount the editor)
 * before the reply arrives, and the editor reads its start when it mounts.
 */
async function openEditorForRound(machine, facts, roundNumber, scoreData) {
    const start = toEditorStart(facts.currentPlayer.id, roundNumber, scoreData);
    setState(machine, { editorStart: start });

    const result = await machine.ports.perform('setEditMode', 'Edit scores', () =>
        machine.ports.game.setEditMode(facts.room.id, true));
    if (result === undefined && machine.state.editorStart === start) {
        setState(machine, { editorStart: null });
    }
}

// --- Late scores -----------------------------------------------------------------

async function askAbout(machine, prompt) {
    const answer = await machine.ports.ask({
        title: prompt.title,
        description: prompt.description,
        confirmText: prompt.confirmText,
        cancelText: prompt.cancelText,
    });
    return roundMovedAction(prompt, answer);
}

/** Asks what to do with a score whose round has closed; see roundMovedPrompt. */
async function resolveRoundMoved(machine, facts, { roundNumber, currentRound, storedScore }, scoreData) {
    const prompt = roundMovedPrompt({ roundNumber, currentRound, storedScore, isHost: facts.isHost });
    const choice = await askAbout(machine, prompt);

    if (choice === 'keep') {
        return;
    }
    finishEntry(machine, facts, roundNumber);
    if (choice === 'edit') {
        await openEditorForRound(machine, facts, roundNumber, scoreData);
    }
}

/** Host only: asks about each restored older round's cards, one prompt at a time. */
async function resolveRestoredRounds(machine, facts, rounds) {
    const scope = scopeOf(facts.room);
    for (const round of rounds) {
        const pending = loadPendingCards(machine.ports.storage, scope, round);
        if (!pending) {
            continue;
        }

        const storedScore = findStoredScore(facts.roundScores, facts.currentPlayer.id, round);
        const details = { roundNumber: round, currentRound: facts.room.current_round, storedScore };
        await resolveRoundMoved(machine, facts, details, {
            cards: pending.cards,
            duplicateAllowed: pending.duplicateAllowed,
            flip7AttackPlayerId: pending.flip7AttackPlayerId,
        });
    }
}

/** Taking a score back was too late: the host can still fix it in the editor. */
async function resolveRetractTooLate(machine, facts, { roundNumber, currentRound, storedScore }) {
    if (!facts.isHost) {
        machine.ports.notify.info(ROUND_CLOSED_MESSAGE);
        return;
    }

    const prompt = retractMovedPrompt({ roundNumber, currentRound, storedScore });
    if (await askAbout(machine, prompt) === 'edit') {
        await openEditorForRound(machine, facts, roundNumber, {
            cards: storedScore?.cards ?? [],
            isBust: storedScore?.busted,
            duplicateAllowed: storedScore?.duplicate_allowed,
            flip7AttackPlayerId: storedScore?.flip7_attack_player_id,
        });
    }
}

/** A closed round or finished game: what it means when my score couldn't be changed. */
async function resolveScoreNotChanged(machine, facts, outcome, roundNumber) {
    if (outcome.kind === 'round_moved') {
        await resolveRetractTooLate(machine, facts, { roundNumber, ...outcome });
    } else if (outcome.kind === 'finished') {
        machine.ports.notify.info(facts.isHost ? GAME_FINISHED_MESSAGE : ROUND_CLOSED_MESSAGE);
    }
}

// --- Sending ---------------------------------------------------------------------

/** @returns {Promise<ScoreOutcome>} */
async function send(machine, name, label, call) {
    const outcome = await machine.ports.perform(name, label, () => submitWithOutcome(call));
    return outcome ?? FAILED;
}

/**
 * Submits a score for a round. A failure leaves the entry open so the player can retry. A score for a
 * round that moved on while the entry was open is caught here or by the server's `round_mismatch`,
 * instead of landing in the next round (bug 7.5).
 *
 * `facts` is the room as it was when the player acted: the server has the last word on the round.
 */
async function submitForRound(machine, facts, roundNumber, scoreData, gameMode = getRules(facts.room?.game_mode).id) {
    const { room, currentPlayer, roundScores } = facts;
    if (!room || !currentPlayer) {
        return NOTHING_TO_DO;
    }

    if (roundNumber !== room.current_round) {
        const storedScore = findStoredScore(roundScores, currentPlayer.id, roundNumber);
        /** @type {ScoreOutcome} */
        const moved = { kind: 'round_moved', currentRound: room.current_round, storedScore };
        await resolveRoundMoved(machine, facts, { roundNumber, ...moved }, scoreData);
        return moved;
    }

    const payload = toScorePayload(roundNumber, scoreData, gameMode);
    const outcome = await send(machine, 'submitScore', 'Submit score', () => machine.ports.game.submitScore(room.id, payload));

    if (outcome.kind === 'failed') {
        return outcome;
    }
    if (outcome.kind === 'round_moved') {
        await resolveRoundMoved(machine, facts, { roundNumber, ...outcome }, scoreData);
        return outcome;
    }
    // The host switched mode while this entry was open. The action runner has refetched, so the open
    // entry re-scores under the new mode with its cards kept, and the player confirms again.
    if (outcome.kind === 'mode_changed') {
        return outcome;
    }

    if (outcome.kind === 'saved') {
        machine.awaitingRound = roundNumber;
        settleAwaitedRound(machine);
    }
    // `saved`, or `finished`: the game is over, so there is nothing left to submit.
    finishEntry(machine, facts, roundNumber);
    return outcome;
}

// --- Taking a score back ---------------------------------------------------------

/**
 * The toast's Undo retracts whatever score I have for the round, so once the bust is on its way out a
 * stale tap would take back the score entered after it. Goes before the request, as the panel still
 * offers Undo if the request fails. An undefined id would dismiss every toast.
 */
function dismissUndoToast(machine) {
    if (machine.undoToast === null) {
        return;
    }
    machine.ports.notify.dismiss(machine.undoToast);
    machine.undoToast = null;
}

/** Retracts my score for a round. A failure leaves everything as it was. */
async function retract(machine, facts, roundNumber) {
    dismissUndoToast(machine);

    const outcome = await send(machine, 'retractScore', 'Undo score', () => machine.ports.game.retractScore(facts.room.id, roundNumber));
    if (outcome.kind === 'saved') {
        // My submit may not have shown up yet, and it isn't there to announce any more.
        machine.awaitingRound = null;
    }
    await resolveScoreNotChanged(machine, facts, outcome, roundNumber);
    return outcome;
}

/**
 * My score as it really stands. My last minus card's reply may be ahead of the room data, and working
 * from the older copy would lose that card. A newer stored copy wins, as the host may have edited it.
 */
function latestScore(machine, storedScore) {
    const saved = machine.savedBust;
    if (saved === null || saved.id !== storedScore.id) {
        return storedScore;
    }
    return saved.updated_date >= storedScore.updated_date ? saved : storedScore;
}

/**
 * Sends a bust again after the host changed the mode while it was going out. A bust is valid in any
 * mode, and with no entry open there is nothing on screen to re-score and confirm, so it has to land
 * or say why it didn't.
 */
async function resubmitBust(machine, facts, roundNumber, gameMode, minusValues) {
    const outcome = await submitForRound(machine, facts, roundNumber, bustScore(gameMode, minusValues), gameMode);
    if (outcome.kind === 'mode_changed') {
        machine.ports.notify.error('The game mode changed and your bust wasn\'t saved. Please try again.');
    }
    return outcome;
}

// --- Room changes ----------------------------------------------------------------

/**
 * A new game (or the end of this one) starts with no entry open, and no cards left over that a reload
 * could bring back.
 */
function applyStatusChange(machine, status, roomId) {
    if (status === 'playing') {
        return;
    }

    closeEntry(machine);
    if (status !== undefined && roomId) {
        clearRoomPendingCards(machine.ports.storage, roomId);
    }
}

/** After a reload or tab discard, reopens the entry the player was in the middle of. */
function restoreOnce(machine, facts) {
    const { room, currentPlayer, isHost } = facts;
    if (room?.status !== 'playing' || !currentPlayer) {
        return;
    }
    const scope = scopeOf(room);
    if (machine.restoredScope === scope) {
        return;
    }
    machine.restoredScope = scope;

    const { storage, notify, takeDiscardNotice } = machine.ports;
    // Drafts from an earlier game (the tab missed it ending) or in the old key format can never be
    // restored, so drop them.
    clearOtherGamesPendingCards(storage, room.id, scope);
    const rounds = listPendingRounds(storage, scope);
    const hadCurrentRound = rounds.includes(room.current_round);
    const plan = planPendingRestore({
        rounds,
        currentRound: room.current_round,
        hasSubmittedCurrent: currentPlayer.has_submitted_round === true,
        isHost,
    });
    for (const round of plan.clear) {
        clearPendingCards(storage, scope, round);
    }

    const current = loadPendingCards(storage, scope, room.current_round);
    if (plan.restoreCurrent && current) {
        setState(machine, { entry: { source: current.source, roundNumber: room.current_round } });
        notify.info('Restored the cards you were entering');
    } else if (!hadCurrentRound && takeDiscardNotice()) {
        notify.info('This page was reloaded in the background. If you were scanning cards, please try again.');
    }

    resolveRestoredRounds(machine, facts, plan.resolve);
}

/** Works through what changed in the room data since the last sync, each change seen exactly once. */
function applyFacts(machine, facts) {
    const { room } = facts;
    machine.facts = facts;
    const seen = machine.seen;
    const status = room?.status;
    const gameNumber = room?.game_number;
    const isEditing = room?.is_edit_mode === true;

    if (status !== seen.status) {
        applyStatusChange(machine, status, room?.id ?? null);
    }
    // A tab that missed the finished and waiting statuses sees playing -> playing with a new game
    // number. The open entry still holds the earlier game's cards, so close it before they are saved
    // or submitted in the new game (X5b). The restore below runs again for the new game's scope.
    if (gameNumber !== seen.gameNumber && seen.gameNumber !== undefined) {
        closeEntry(machine);
    }
    if (isEditing !== seen.isEditing && !isEditing && machine.state.editorStart !== null) {
        setState(machine, { editorStart: null });
    }
    machine.seen = { status, gameNumber, isEditing };

    restoreOnce(machine, facts);
    settleAwaitedRound(machine);
}

// --- Drafts ----------------------------------------------------------------------

/**
 * Rewrites the open entry's draft. Works from the stored draft rather than anything read at render, as
 * saving doesn't re-render, so what was read then can be several changes behind.
 */
function updateDraft(machine, change) {
    const scope = scopeOf(machine.facts.room);
    const entry = machine.state.entry;
    if (!entry || !scope) {
        return;
    }

    const { storage } = machine.ports;
    const stored = loadPendingCards(storage, scope, entry.roundNumber);
    const draft = change(entry, stored);
    if (draft) {
        savePendingCards(storage, scope, entry.roundNumber, draft);
    }
}

// --- The lifecycle ---------------------------------------------------------------

/**
 * @param {ScorePorts} ports
 */
export function createScoreLifecycle(ports) {
    const machine = {
        ports,
        // entry: { source: 'scanner'|'manual', roundNumber } while an entry screen is open, else null.
        // editorStart: host only: { player_id, round_number, cards, ... } to open the score editor on.
        // enteredScoreRound: the round of the score or bust I just sent, until the game screen has
        // scrolled to the turn card for it (X47). The room data can arrive before or after the reply.
        state: { entry: null, editorStart: null, enteredScoreRound: null },
        listeners: new Set(),
        facts: { room: null, currentPlayer: null, roundScores: [], isHost: false },
        // The values applyFacts last acted on.
        seen: { status: undefined, gameNumber: undefined, isEditing: undefined },
        // The draft scope (room and game) the restore last ran for.
        restoredScope: null,
        // The round my last successful submit was for, until the room data shows whether it completed
        // the round.
        awaitingRound: null,
        // The Bust tile's Undo toast, while one may be showing.
        undoToast: null,
        // My score as Add a minus card last saved it, which the room data may not have caught up with.
        savedBust: null,
    };

    return {
        getState: () => machine.state,

        /** @returns {() => void} unsubscribe */
        subscribe(listener) {
            machine.listeners.add(listener);
            return () => {
                machine.listeners.delete(listener);
            };
        },

        /**
         * The room data as it now stands. Call it after every change.
         *
         * @param {{room: object|null, currentPlayer: object|null, roundScores: object[], isHost: boolean}} facts
         */
        sync(facts) {
            applyFacts(machine, facts);
        },

        // --- Entry screens ---

        /** @param {'scanner'|'manual'} source */
        openEntry(source) {
            const { room } = machine.facts;
            if (room) {
                setState(machine, { entry: { source, roundNumber: room.current_round } });
            }
        },

        closeEntry() {
            closeEntry(machine);
        },

        switchToManualEntry() {
            const { entry } = machine.state;
            if (entry) {
                setState(machine, { entry: { ...entry, source: 'manual' } });
            }
        },

        clearEnteredScoreRound() {
            setState(machine, { enteredScoreRound: null });
        },

        // --- Drafts ---

        /**
         * The open entry's draft in `room`, or null. Takes the room being rendered, as sync() only runs
         * after that render.
         */
        readDraft(room) {
            const { entry } = machine.state;
            if (!entry || !room) {
                return null;
            }
            return loadPendingCards(ports.storage, scopeOf(room), entry.roundNumber);
        },

        saveDraft(cards) {
            updateDraft(machine, (entry, stored) => buildDraft(entry.source, cards, stored ?? {}));
        },

        /** Nothing to do with no draft: the override is only offered for a hand, which has been saved. */
        saveDuplicateAllowed(duplicateAllowed) {
            updateDraft(machine, (entry, stored) => stored && buildDraft(entry.source, stored.cards, { ...stored, duplicateAllowed }));
        },

        /** Likewise: the Flip 7 choice is only offered for a hand, which has been saved. */
        saveAttack(flip7AttackPlayerId) {
            updateDraft(machine, (entry, stored) => stored && buildDraft(entry.source, stored.cards, { ...stored, flip7AttackPlayerId }));
        },

        // --- Scores ---

        /**
         * @param {{cards: object[], baseSum: number, finalScore: number}} scoreData
         * @returns {Promise<ScoreOutcome>}
         */
        async submit(scoreData) {
            const facts = machine.facts;
            const roundNumber = machine.state.entry?.roundNumber ?? facts.room?.current_round;
            const outcome = await submitForRound(machine, facts, roundNumber, scoreData);
            if (outcome.kind === 'saved') {
                setState(machine, { enteredScoreRound: roundNumber });
            }
            return outcome;
        },

        /**
         * Sent without asking, as the toast and the submitted panel both offer Undo (X45). A mode where
         * modifiers reach a bust chooses `minusValues` on a step first. The toast's Undo keeps no draft,
         * so a bust with minus cards relies on the panel's Undo bust.
         *
         * @param {string[]} [minusValues]
         * @returns {Promise<ScoreOutcome>}
         */
        async bust(minusValues = []) {
            const facts = machine.facts;
            if (!facts.room || !facts.currentPlayer) {
                return NOTHING_TO_DO;
            }

            const roundNumber = facts.room.current_round;
            const rules = getRules(facts.room.game_mode);
            let outcome = await submitForRound(machine, facts, roundNumber, bustScore(rules.id, minusValues));
            if (outcome.kind === 'mode_changed') {
                outcome = await resubmitBust(machine, facts, roundNumber, outcome.gameMode, minusValues);
            }
            if (outcome.kind === 'saved') {
                setState(machine, { enteredScoreRound: roundNumber });
            }
            if (outcome.kind === 'saved' && minusValues.length === 0) {
                machine.undoToast = ports.notify.info('You busted this round', {
                    duration: UNDO_TOAST_MS,
                    action: { label: 'Undo', onClick: () => retract(machine, facts, roundNumber) },
                });
            }
            return outcome;
        },

        /**
         * Undo bust and Change score on the submitted panel. Any cards go into a draft first, so a dropped
         * connection or a reload restores them as usual. A failed retract keeps that draft, because the
         * retract may have landed; if it didn't, the restore after a reload drops a draft for a submitted
         * round. A declared bust has no cards to go back to, so it returns to the three tiles.
         *
         * @returns {Promise<ScoreOutcome>}
         */
        async takeBack() {
            const facts = machine.facts;
            const storedScore = findMyCurrentScore(facts);
            if (!storedScore) {
                return NOTHING_TO_DO;
            }

            const roundNumber = facts.room.current_round;
            const scope = scopeOf(facts.room);
            const myScore = latestScore(machine, storedScore);
            const cards = myScore.cards ?? [];
            const reopensEntry = cards.length > 0 || myScore.busted !== true;
            if (cards.length > 0) {
                const draft = buildDraft('manual', cards, {
                    duplicateAllowed: myScore.duplicate_allowed === true,
                    flip7AttackPlayerId: myScore.flip7_attack_player_id,
                });
                savePendingCards(ports.storage, scope, roundNumber, draft);
            }

            const outcome = await retract(machine, facts, roundNumber);
            if (outcome.kind === 'saved' && reopensEntry) {
                setState(machine, { entry: { source: 'manual', roundNumber } });
            } else if (reachedServer(outcome) && outcome.kind !== 'saved') {
                clearPendingCards(ports.storage, scope, roundNumber);
            }
            return outcome;
        },

        /**
         * Add a minus card on a busted panel (§3.14): the same score again with one more card, still busted.
         * It goes straight to the API rather than through submitForRound, because I've already submitted, so
         * there is no entry to finish and the round closing later isn't this submit's doing (X12). The Bust
         * tile's toast goes first, as its Undo keeps no draft and would throw the added cards away (X45).
         *
         * @param {string} value
         * @returns {Promise<ScoreOutcome>}
         */
        async addMinusCard(value) {
            const facts = machine.facts;
            const storedScore = findMyCurrentScore(facts);
            if (!storedScore) {
                return NOTHING_TO_DO;
            }

            dismissUndoToast(machine);

            const roundNumber = facts.room.current_round;
            const gameMode = getRules(facts.room.game_mode).id;
            const cards = [...(latestScore(machine, storedScore).cards ?? []), { type: 'subtractor', value }];
            const score = calculateFlip7Score(cards, gameMode, { busted: true });
            const payload = toScorePayload(roundNumber, { cards, ...score }, gameMode);

            const outcome = await send(machine, 'addMinusCard', 'Add minus card', () => ports.game.submitScore(facts.room.id, payload));
            if (outcome.kind === 'saved') {
                machine.savedBust = outcome.response.round_score;
            }
            await resolveScoreNotChanged(machine, facts, outcome, roundNumber);
            return outcome;
        },
    };
}
