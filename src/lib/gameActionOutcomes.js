// Turns game action errors (see "Game actions" in docs/backend-contract.md) into what the UI
// should do about them. Errors look like `Error{status, data: {code, ...}}`.

const CONFLICT_STATUS = 409;

export function errorCode(error) {
    return error?.data?.code ?? null;
}

/**
 * Wraps an action so that the listed error codes count as success, e.g. `player_not_found`
 * on a repeated leave means "already gone". Resolves with the response, or
 * `{ alreadyDone: true, code }` when one of `doneCodes` was returned.
 */
export async function treatCodesAsDone(action, doneCodes) {
    try {
        return await action();
    } catch (error) {
        const code = errorCode(error);
        if (doneCodes.includes(code)) {
            return { alreadyDone: true, code };
        }
        throw error;
    }
}

// --- Score submits -------------------------------------------------------------

/**
 * The `submit-score` / `edit-score` body for a score from calculateFlip7Score. The server
 * only accepts `{value: string, type: string}` cards, so other fields are dropped. A duplicate
 * hand counts as busted as much as the Bust tile does, and the flags and the Flip 7 target are left
 * out when off, which the server reads the same.
 *
 * @param {number} roundNumber
 * @param {{cards: object[], baseSum: number, finalScore: number, isBust?: boolean, duplicateAllowed?: boolean, flip7AttackPlayerId?: string|null}} scoreData
 * @param {string} [gameMode]  the mode the score was worked out under, which the server checks
 *        against the room's (`mode_changed`)
 */
export function toScorePayload(roundNumber, { cards, baseSum, finalScore, isBust, duplicateAllowed, flip7AttackPlayerId }, gameMode) {
    const serverCards = [];
    for (const card of cards) {
        serverCards.push({ value: String(card.value ?? ''), type: String(card.type ?? 'number') });
    }

    const payload = { round_number: roundNumber, cards: serverCards, base_sum: baseSum, final_score: finalScore };
    if (gameMode) {
        payload.game_mode = gameMode;
    }
    if (isBust) {
        payload.busted = true;
    }
    if (duplicateAllowed) {
        payload.duplicate_allowed = true;
    }
    if (flip7AttackPlayerId) {
        payload.flip7_attack_player_id = flip7AttackPlayerId;
    }
    return payload;
}

/**
 * What a failed `submit-score` means, or null when it's a real failure to report.
 *
 * - `round_moved`: the round was already closed. `currentRound` is the server's round,
 *   `storedScore` the caller's saved RoundScore for the submitted round (or null).
 * - `finished`: the game ended meanwhile, so there is nothing left to submit.
 * - `mode_changed`: the host changed the mode after this score was worked out. `gameMode` is the
 *   room's mode now.
 *
 * @returns {{kind: 'round_moved', currentRound: number|null, storedScore: object|null}
 *          | {kind: 'finished'} | {kind: 'mode_changed', gameMode: string} | null}
 */
export function classifySubmitError(error) {
    if (error?.status !== CONFLICT_STATUS) {
        return null;
    }

    const data = error.data ?? {};
    if (data.code === 'round_mismatch') {
        return {
            kind: 'round_moved',
            currentRound: data.current_round ?? null,
            storedScore: data.stored_score ?? null,
        };
    }

    if (data.code === 'mode_changed') {
        return { kind: 'mode_changed', gameMode: data.game_mode };
    }

    const isFinished = data.code === 'wrong_status' && data.status === 'finished';
    if (isFinished) {
        return { kind: 'finished' };
    }
    return null;
}

/**
 * Submits a score and resolves with the outcome instead of rejecting for the expected
 * conflicts. A 200 (including `already_applied` after a lost response) is `saved`.
 *
 * @returns {Promise<{kind: 'saved', response: object} | NonNullable<ReturnType<typeof classifySubmitError>>>}
 *          rejects only for real failures
 */
export async function submitWithOutcome(submit) {
    try {
        const response = await submit();
        return { kind: 'saved', response };
    } catch (error) {
        const outcome = classifySubmitError(error);
        if (outcome) {
            return outcome;
        }
        throw error;
    }
}

function describeStoredScore(storedScore) {
    if (!storedScore) {
        return 'No score was saved for you in that round.';
    }
    return `Your saved score for that round is ${storedScore.final_score}.`;
}

/**
 * The prompt shown when a score was entered for a round that has since closed. The host can
 * open the score editor for that round (`confirmAction: 'edit'`); everyone else can only
 * discard the cards (`confirmAction: 'discard'`, with "keep" as the way back). Closing the
 * dialog without choosing (`dismissAction`) always keeps the cards: discarding them is only
 * ever done by tapping the button that says so.
 *
 * @param {{roundNumber: number, currentRound: number|null, storedScore: object|null, isHost: boolean}} details
 * @returns {{title: string, description: string, confirmText: string, cancelText: string,
 *            confirmAction: 'edit'|'discard', cancelAction: 'discard'|'keep', dismissAction: 'keep'}}
 */
export function roundMovedPrompt({ roundNumber, currentRound, storedScore, isHost }) {
    let movedTo = 'has moved on';
    if (currentRound !== null && currentRound !== undefined) {
        movedTo = `is now on round ${currentRound}`;
    }
    const description = `You entered this score for round ${roundNumber}, but the game ${movedTo}, so it wasn't saved. ${describeStoredScore(storedScore)}`;

    if (isHost) {
        return {
            title: 'The round moved on',
            description: `${description} You can put these cards into round ${roundNumber} with the score editor.`,
            confirmText: `Edit round ${roundNumber}`,
            cancelText: 'Discard',
            confirmAction: 'edit',
            cancelAction: 'discard',
            dismissAction: 'keep',
        };
    }

    return {
        title: 'The round moved on',
        description: `${description} Ask the host if it needs fixing.`,
        confirmText: 'Discard score',
        cancelText: 'Keep for now',
        confirmAction: 'discard',
        cancelAction: 'keep',
        dismissAction: 'keep',
    };
}

/**
 * The prompt shown to the host when taking their own score back was too late: the score stands, and
 * the score editor can still fix it. Same shape as roundMovedPrompt, whose wording is about a score
 * that wasn't saved. Anyone else just gets told to ask the host.
 *
 * @param {{roundNumber: number, currentRound: number|null, storedScore: object|null}} details
 * @returns {ReturnType<typeof roundMovedPrompt>}
 */
export function retractMovedPrompt({ roundNumber, currentRound, storedScore }) {
    return {
        title: 'The round moved on',
        description: `Round ${roundNumber} has closed and the game is now on round ${currentRound}, so your score stays. ${describeStoredScore(storedScore)} You can fix it with the score editor.`,
        confirmText: `Edit round ${roundNumber}`,
        cancelText: 'Leave it',
        confirmAction: 'edit',
        cancelAction: 'keep',
        dismissAction: 'keep',
    };
}

/**
 * The action for how the round-moved prompt was answered.
 *
 * @param {ReturnType<typeof roundMovedPrompt>} prompt
 * @param {'confirm'|'cancel'|'dismiss'} answer  from the confirm dialog's `ask`
 * @returns {'edit'|'discard'|'keep'}
 */
export function roundMovedAction(prompt, answer) {
    if (answer === 'confirm') {
        return prompt.confirmAction;
    }
    if (answer === 'cancel') {
        return prompt.cancelAction;
    }
    return prompt.dismissAction;
}
