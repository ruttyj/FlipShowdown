// useScoreEntry. The drafts live in the real sessionStorage, which
// setup.js clears after every test.
import { act, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadPendingCards, pendingCardsKey, pendingCardsScope, savePendingCards } from '@/lib/pendingCards'
import { useScoreEntry } from '@/pages/gameRoom/useScoreEntry'
import { makePlayer, makeRoom, renderGameHook, ROOM_ID } from '../fixtures/renderGameHook.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

function isEntryOpen(view) {
  const entry = view.result.current
  return entry.showScanner || entry.showManualEntry
}

const CARDS = [{ value: '7', type: 'number' }, { value: 'x2', type: 'modifier' }]
const SCORE = { cards: CARDS, baseSum: 7, finalScore: 14 }

// --- Fixtures --------------------------------------------------------------------

/** useScoreEntry's props for p1 in round 2 of a playing room. */
function makeProps(overrides = {}) {
  return {
    room: makeRoom({ current_round: 2 }),
    currentPlayer: makePlayer('p1', { is_host: true }),
    roundScores: [],
    isHost: false,
    ...overrides,
  }
}

/** Renders useScoreEntry with `props`; `view.rerender(props)` changes them. */
function renderScoreEntry(props = makeProps(), options = {}) {
  const setEditMode = vi.fn(async () => ({ ok: true }))
  return renderGameHook(
    (fixture, hookProps) => useScoreEntry({ ...hookProps, ...fixture }),
    { ...options, initialProps: props },
  )
}

// makeRoom's rooms are on game 1 unless a test says otherwise.
function saveDraft(roundNumber, source = 'manual', gameNumber = 1) {
  savePendingCards(sessionStorage, pendingCardsScope(ROOM_ID, gameNumber), roundNumber, { source, cards: CARDS })
}

function loadDraft(roundNumber, gameNumber = 1) {
  return loadPendingCards(sessionStorage, pendingCardsScope(ROOM_ID, gameNumber), roundNumber)
}

function conflict(data) {
  return Object.assign(new Error('Conflict'), { status: 409, data })
}

/** Opens an entry screen and drafts CARDS in it, as the scanner or manual entry would. */
function openWithDraft(view, source) {
  act(() => view.result.current.openScoreEntry(source))
  act(() => view.result.current.savePendingDraft(CARDS))
}

async function submit(view) {
  let outcome
  await act(async () => {
    outcome = await view.result.current.submitScore(SCORE)
  })
  return outcome
}

// --- Entry screens ---------------------------------------------------------------

describe('entry screens', () => {
  it('opens the scanner or manual entry for the current round, and close clears it', () => {
    const view = renderScoreEntry()

    act(() => view.result.current.openScoreEntry('scanner'))
    expect(view.result.current.showScanner).toBe(true)
    expect(view.result.current.showManualEntry).toBe(false)
    expect(isEntryOpen(view)).toBe(true)

    act(() => view.result.current.closeScoreEntry())
    expect(view.result.current.showScanner).toBe(false)
    expect(isEntryOpen(view)).toBe(false)

    act(() => view.result.current.openScoreEntry('manual'))
    expect(view.result.current.showManualEntry).toBe(true)
    expect(isEntryOpen(view)).toBe(true)
  })

  it('switching to manual entry keeps the round and the cards drafted so far', () => {
    const view = renderScoreEntry()
    openWithDraft(view, 'scanner')

    act(() => view.result.current.switchToManualEntry())

    expect(view.result.current.showManualEntry).toBe(true)
    expect(view.result.current.showScanner).toBe(false)
    expect(isEntryOpen(view)).toBe(true)
    expect(view.result.current.pendingCards).toEqual(CARDS)
  })

  it('saves the draft keyed by room, game and round', () => {
    const view = renderScoreEntry(makeProps({ room: makeRoom({ current_round: 2, game_number: 4 }) }))

    openWithDraft(view, 'scanner')

    const stored = JSON.parse(sessionStorage.getItem(pendingCardsKey(pendingCardsScope(ROOM_ID, 4), 2)))
    expect(stored).toEqual({ source: 'scanner', cards: CARDS })
  })

  it.each(['finished', 'waiting'])('the room going to %s closes the entry and clears saved drafts', (status) => {
    const props = makeProps()
    const view = renderScoreEntry(props)
    openWithDraft(view, 'manual')
    saveDraft(1)

    view.rerender({ ...props, room: { ...props.room, status } })

    expect(view.result.current.showManualEntry).toBe(false)
    expect(isEntryOpen(view)).toBe(false)
    expect(loadDraft(1)).toBeNull()
    expect(loadDraft(2)).toBeNull()
  })

  // X5b: the tab missed finished/waiting, so it sees playing -> playing with a new game number.
  it('a new game starting closes the entry and drops the earlier game\'s draft', async () => {
    const props = makeProps({ room: makeRoom({ current_round: 2, game_number: 1 }) })
    const view = renderScoreEntry(props)
    openWithDraft(view, 'scanner')

    view.rerender({ ...props, room: { ...props.room, current_round: 2, game_number: 2 } })

    expect(view.result.current.showScanner).toBe(false)
    expect(isEntryOpen(view)).toBe(false)
    act(() => view.result.current.savePendingDraft(CARDS))
    expect(loadDraft(2, 2)).toBeNull()
    await waitFor(() => expect(loadDraft(2, 1)).toBeNull())
  })
})

// --- Restoring after a reload ----------------------------------------------------

describe('restoring after a reload', () => {
  it('reopens the entry with its cards when a draft is saved for the current round', () => {
    saveDraft(2, 'scanner')

    const view = renderScoreEntry()

    expect(view.result.current.showScanner).toBe(true)
    expect(isEntryOpen(view)).toBe(true)
    expect(view.result.current.pendingCards).toEqual(CARDS)
  })

  it('asks the host about each older round draft in turn', async () => {
    saveDraft(1)
    saveDraft(2)
    const props = makeProps({ room: makeRoom({ current_round: 3 }), isHost: true })

    const view = renderScoreEntry(props, { answers: ['cancel', 'cancel'] })
    // The first prompt is already open; record what was left when the second one opens.
    const draftsAtPrompt = []
    const answerFromQueue = view.ask.getMockImplementation()
    view.ask.mockImplementation((options) => {
      draftsAtPrompt.push({ round1: loadDraft(1), round2: loadDraft(2) })
      return answerFromQueue(options)
    })

    await waitFor(() => expect(loadDraft(2)).toBeNull())
    expect(loadDraft(1)).toBeNull()
    const prompts = view.ask.mock.calls.map(([options]) => options.confirmText)
    expect(prompts).toEqual(['Edit round 1', 'Edit round 2'])
    expect(draftsAtPrompt).toEqual([{ round1: null, round2: { source: 'manual', cards: CARDS } }])
  })

  it("drops other players' older drafts without asking", async () => {
    saveDraft(1)
    saveDraft(2)
    const props = makeProps({ room: makeRoom({ current_round: 3 }), currentPlayer: makePlayer('p2') })

    const view = renderScoreEntry(props)

    await waitFor(() => expect(loadDraft(1)).toBeNull())
    expect(loadDraft(2)).toBeNull()
    expect(view.ask).not.toHaveBeenCalled()
    expect(isEntryOpen(view)).toBe(false)
  })

  // X5: the tab was discarded in game 1, round 3 and missed the game ending and play-again.
  it("doesn't restore a draft from an earlier game in the same room, and drops it", async () => {
    saveDraft(3, 'scanner', 1)
    const props = makeProps({ room: makeRoom({ current_round: 3, game_number: 2 }), isHost: true })

    const view = renderScoreEntry(props)

    await waitFor(() => expect(loadDraft(3, 1)).toBeNull())
    expect(isEntryOpen(view)).toBe(false)
    expect(view.result.current.pendingCards).toEqual([])
    expect(view.ask).not.toHaveBeenCalled()
  })

  it('ignores and drops a draft saved under the old room-and-round key', async () => {
    const oldKey = `flip7_pending_cards:${ROOM_ID}:3`
    sessionStorage.setItem(oldKey, JSON.stringify({ source: 'manual', cards: CARDS }))
    const props = makeProps({ room: makeRoom({ current_round: 3 }), isHost: true })

    const view = renderScoreEntry(props)

    await waitFor(() => expect(sessionStorage.getItem(oldKey)).toBeNull())
    expect(isEntryOpen(view)).toBe(false)
    expect(view.ask).not.toHaveBeenCalled()
  })

  it('restores a game 1 draft in a room saved without a game number', () => {
    saveDraft(2, 'manual', 1)
    const room = makeRoom({ current_round: 2 })
    delete room.game_number

    const view = renderScoreEntry(makeProps({ room }))

    expect(view.result.current.showManualEntry).toBe(true)
    expect(view.result.current.pendingCards).toEqual(CARDS)
  })
})

describe('the discarded-tab toast', () => {
  afterEach(() => {
    delete document.wasDiscarded
  })

  // X21: document.wasDiscarded stays true for the page's life, so every play-again used to
  // show the toast again. The shown flag is module state, so the run needs fresh modules.
  it('shows the reloaded-in-the-background toast once per page load, not once per game', async () => {
    vi.resetModules()
    document.wasDiscarded = true
    const { toast } = await import('sonner')
    const infoSpy = vi.spyOn(toast, 'info')
    const fixtures = await import('../fixtures/renderGameHook.jsx')
    const { useScoreEntry: freshUseScoreEntry } = await import('@/pages/gameRoom/useScoreEntry')
    const setEditMode = vi.fn(async () => ({ ok: true }))
    const propsFor = (gameNumber) => ({
      room: fixtures.makeRoom({ current_round: 1, game_number: gameNumber }),
      currentPlayer: fixtures.makePlayer('p1'),
      roundScores: [],
      isHost: false,
    })

    const view = fixtures.renderGameHook(
      (fixture, hookProps) => freshUseScoreEntry({ ...hookProps, ...fixture }),
      { initialProps: propsFor(1) },
    )
    view.rerender(propsFor(2))
    view.rerender(propsFor(3))

    const discardToasts = infoSpy.mock.calls.filter(([message]) => message.includes('reloaded in the background'))
    expect(discardToasts).toHaveLength(1)
  })
})

// --- Submitting ------------------------------------------------------------------

describe('submitting', () => {
  it('a successful submit closes the entry and clears the draft', async () => {
    const view = renderScoreEntry()
    openWithDraft(view, 'manual')

    const outcome = await submit(view)

    expect(outcome.kind).toBe('saved')
    expect(view.game.submitScore).toHaveBeenCalledWith(ROOM_ID, {
      round_number: 2,
      game_mode: 'classic',
      cards: CARDS,
      base_sum: 7,
      final_score: 14,
    })
    expect(isEntryOpen(view)).toBe(false)
    expect(loadDraft(2)).toBeNull()
  })

  it('a failed submit keeps the entry open and the draft saved for a retry', async () => {
    const view = renderScoreEntry(makeProps(), {
      game: { submitScore: () => Promise.reject(new Error('Network down')) },
    })
    openWithDraft(view, 'manual')

    const outcome = await submit(view)

    expect(outcome).toEqual({ kind: 'failed' })
    expect(view.result.current.showManualEntry).toBe(true)
    expect(view.result.current.pendingCards).toEqual(CARDS)
    expect(loadDraft(2)).toEqual({ source: 'manual', cards: CARDS })
  })

})

// --- X12: the success toast for the submit that completes the round ----------------

describe('the round of a score just entered (X47)', () => {
  it('is empty until a score from an entry screen is saved', async () => {
    const view = renderScoreEntry()
    expect(view.result.current.enteredScoreRound).toBeNull()

    openWithDraft(view, 'manual')
    await submit(view)

    expect(view.result.current.enteredScoreRound).toBe(2)
  })

  it('clears once the confirmation has used it', async () => {
    const view = renderScoreEntry()
    openWithDraft(view, 'scanner')
    await submit(view)

    act(() => view.result.current.clearEnteredScoreRound())

    expect(view.result.current.enteredScoreRound).toBeNull()
  })

  it('stays empty when the submit fails', async () => {
    const view = renderScoreEntry(makeProps(), {
      game: { submitScore: () => Promise.reject(new Error('Network down')) },
    })
    openWithDraft(view, 'manual')

    await submit(view)

    expect(view.result.current.enteredScoreRound).toBeNull()
  })

  it('is set by the Bust tile too', async () => {
    const view = renderScoreEntry(makeProps())

    await act(async () => {
      await view.result.current.bust()
    })

    expect(view.game.submitScore).toHaveBeenCalledTimes(1)
    expect(view.result.current.enteredScoreRound).toBe(2)
  })

  it('stays empty when the bust fails', async () => {
    const view = renderScoreEntry(makeProps(), {
      game: { submitScore: () => Promise.reject(new Error('Network down')) },
    })

    await act(async () => {
      await view.result.current.bust()
    })

    expect(view.result.current.enteredScoreRound).toBeNull()
  })
})

describe('the "Score submitted!" toast', () => {
  const SUBMITTED_MESSAGE = 'Score submitted!'

  function submittedToasts(successSpy) {
    return successSpy.mock.calls.filter(([message]) => message === SUBMITTED_MESSAGE)
  }

  /** The props once my submit is in: still round 2 and waiting, the next round, or finished. */
  function afterSubmitProps(roomOverrides) {
    return makeProps({
      room: makeRoom({ current_round: 2, ...roomOverrides }),
      currentPlayer: makePlayer('p1', { is_host: true, has_submitted_round: true }),
    })
  }

  it('shows once when my submit completes the round', async () => {
    const successSpy = vi.spyOn(toast, 'success')
    const view = renderScoreEntry()
    openWithDraft(view, 'manual')

    await submit(view)
    view.rerender(afterSubmitProps({ current_round: 3 }))

    expect(submittedToasts(successSpy)).toHaveLength(1)
  })

  it('shows once when my submit finishes the game', async () => {
    const successSpy = vi.spyOn(toast, 'success')
    const view = renderScoreEntry()
    openWithDraft(view, 'manual')

    await submit(view)
    view.rerender(afterSubmitProps({ status: 'finished' }))

    expect(submittedToasts(successSpy)).toHaveLength(1)
  })

  it('does not show while others are still to submit, even when the round advances later', async () => {
    const successSpy = vi.spyOn(toast, 'success')
    const view = renderScoreEntry()
    openWithDraft(view, 'manual')

    await submit(view)
    view.rerender(afterSubmitProps({}))
    view.rerender(afterSubmitProps({ current_round: 3 }))

    expect(submittedToasts(successSpy)).toHaveLength(0)
  })

  it('does not show when the submit failed', async () => {
    const successSpy = vi.spyOn(toast, 'success')
    const view = renderScoreEntry(makeProps(), {
      game: { submitScore: () => Promise.reject(new Error('Network down')) },
    })
    openWithDraft(view, 'manual')

    await submit(view)
    view.rerender(afterSubmitProps({ current_round: 3 }))

    expect(submittedToasts(successSpy)).toHaveLength(0)
  })

  it('shows when a bust completes the round', async () => {
    const successSpy = vi.spyOn(toast, 'success')
    const view = renderScoreEntry(makeProps())

    await act(() => view.result.current.bust())
    view.rerender(afterSubmitProps({ current_round: 3 }))

    expect(submittedToasts(successSpy)).toHaveLength(1)
  })
})

// --- Undoing a bust, changing a score (X45) -----------------------------------------

describe('the bust', () => {
  it('is sent as a declared bust with no cards', async () => {
    const view = renderScoreEntry(makeProps())

    await act(() => view.result.current.bust())

    expect(view.game.submitScore).toHaveBeenCalledWith(ROOM_ID, expect.objectContaining({
      round_number: 2,
      cards: [],
      final_score: 0,
      busted: true,
    }))
  })

  it('is sent without asking, as Undo takes it back', async () => {
    const view = renderScoreEntry(makeProps({ room: makeRoom({ current_round: 2, game_mode: 'vengeance' }) }))

    await act(() => view.result.current.bust())

    expect(view.confirm).not.toHaveBeenCalled()
    expect(view.ask).not.toHaveBeenCalled()
    expect(view.game.submitScore).toHaveBeenCalledTimes(1)
  })

  it('shows a 4 s toast with an Undo button', async () => {
    const infoSpy = vi.spyOn(toast, 'info')
    const view = renderScoreEntry(makeProps())

    await act(() => view.result.current.bust())

    const [message, options] = infoSpy.mock.calls.at(-1)
    expect(message).toBe('You busted this round')
    expect(options.duration).toBe(4000)
    expect(options.action.label).toBe('Undo')
  })

  it('shows no Undo toast when the bust failed', async () => {
    const infoSpy = vi.spyOn(toast, 'info')
    const failed = renderScoreEntry(makeProps(), {
      game: { submitScore: () => Promise.reject(new Error('Network down')) },
    })
    await act(() => failed.result.current.bust())

    expect(infoSpy).not.toHaveBeenCalled()
  })

  it('Undo on the toast retracts the score for that round', async () => {
    const infoSpy = vi.spyOn(toast, 'info')
    const view = renderScoreEntry(makeProps())
    await act(() => view.result.current.bust())

    await act(async () => {
      await infoSpy.mock.calls.at(-1)[1].action.onClick()
    })

    expect(view.game.retractScore).toHaveBeenCalledWith(ROOM_ID, 2)
    expect(isEntryOpen(view)).toBe(false)
  })

  it('undoing on the panel dismisses the toast, so a stale tap can\'t retract a new score', async () => {
    const infoSpy = vi.spyOn(toast, 'info').mockReturnValue('undo-toast')
    const dismissSpy = vi.spyOn(toast, 'dismiss')
    const roundScores = [{ player_id: 'p1', round_number: 2, cards: [], final_score: 0, busted: true }]
    const view = renderScoreEntry(makeProps({ roundScores }))
    await act(() => view.result.current.bust())
    expect(infoSpy).toHaveBeenCalled()

    await act(() => view.result.current.takeBackScore())

    expect(dismissSpy).toHaveBeenCalledWith('undo-toast')
  })

  it('a retract with no Undo toast showing dismisses nothing, as no id means every toast', async () => {
    const dismissSpy = vi.spyOn(toast, 'dismiss')
    const roundScores = [{ player_id: 'p1', round_number: 2, cards: [], final_score: 0, busted: true }]
    const view = renderScoreEntry(makeProps({ roundScores }))

    await act(() => view.result.current.takeBackScore())

    expect(view.game.retractScore).toHaveBeenCalled()
    expect(dismissSpy).not.toHaveBeenCalled()
  })

  it('a toast is only dismissed once, and a later retract leaves other toasts alone', async () => {
    vi.spyOn(toast, 'info').mockReturnValue('undo-toast')
    const dismissSpy = vi.spyOn(toast, 'dismiss')
    const roundScores = [{ player_id: 'p1', round_number: 2, cards: [], final_score: 0, busted: true }]
    const view = renderScoreEntry(makeProps({ roundScores }))
    await act(() => view.result.current.bust())

    await act(() => view.result.current.takeBackScore())
    await act(() => view.result.current.takeBackScore())

    expect(dismissSpy).toHaveBeenCalledTimes(1)
  })

  it('a retract undoes waiting for the "Score submitted!" toast, so a later advance says nothing', async () => {
    const successSpy = vi.spyOn(toast, 'success')
    const infoSpy = vi.spyOn(toast, 'info')
    const props = makeProps()
    const view = renderScoreEntry(props)
    await act(() => view.result.current.bust())

    await act(async () => {
      await infoSpy.mock.calls.at(-1)[1].action.onClick()
    })
    view.rerender({ ...props, room: makeRoom({ current_round: 3 }) })

    expect(successSpy).not.toHaveBeenCalled()
  })
})

describe('taking my score back', () => {
  const STORED_CARDS = [{ value: '5', type: 'number' }, { value: '9', type: 'number' }]

  function submittedProps(storedFields = {}) {
    return makeProps({
      currentPlayer: makePlayer('p1', { has_submitted_round: true }),
      roundScores: [{ player_id: 'p1', round_number: 2, final_score: 14, cards: STORED_CARDS, ...storedFields }],
    })
  }

  it('a score: saves its cards as a draft before the retract, then reopens entry on them', async () => {
    const draftsAtRetract = []
    const view = renderScoreEntry(submittedProps())
    view.game.retractScore.mockImplementation(async () => {
      draftsAtRetract.push(loadDraft(2))
      return { already_applied: false }
    })

    await act(() => view.result.current.takeBackScore())

    expect(view.game.retractScore).toHaveBeenCalledWith(ROOM_ID, 2)
    expect(draftsAtRetract).toEqual([{ source: 'manual', cards: STORED_CARDS }])
    expect(view.result.current.showManualEntry).toBe(true)
    expect(isEntryOpen(view)).toBe(true)
    expect(view.result.current.pendingCards).toEqual(STORED_CARDS)
  })

  it('keeps the Steal or Swap override with the cards', async () => {
    const view = renderScoreEntry(submittedProps({ duplicate_allowed: true }))

    await act(() => view.result.current.takeBackScore())

    expect(view.result.current.pendingDuplicateAllowed).toBe(true)
  })

  it('a tile bust: goes back to the three tiles, with nothing to restore', async () => {
    const view = renderScoreEntry(submittedProps({ busted: true, cards: [] }))

    await act(() => view.result.current.takeBackScore())

    expect(view.game.retractScore).toHaveBeenCalledWith(ROOM_ID, 2)
    expect(isEntryOpen(view)).toBe(false)
    expect(loadDraft(2)).toBeNull()
  })

  it('a duplicate bust: brings its hand back', async () => {
    const hand = [{ value: '5', type: 'number' }, { value: '5', type: 'number' }]
    const view = renderScoreEntry(submittedProps({ busted: true, cards: hand, final_score: 0 }))

    await act(() => view.result.current.takeBackScore())

    expect(view.result.current.showManualEntry).toBe(true)
    expect(view.result.current.pendingCards).toEqual(hand)
  })

  it('a failed retract leaves the panel as it was, and a reload can still drop the draft', async () => {
    const view = renderScoreEntry(submittedProps(), {
      game: { retractScore: () => Promise.reject(new Error('Network down')) },
    })

    await act(() => view.result.current.takeBackScore())

    expect(isEntryOpen(view)).toBe(false)
    expect(loadDraft(2)).toEqual({ source: 'manual', cards: STORED_CARDS })
  })

  it('a reload after a lost response restores the cards as usual', async () => {
    saveDraft(2)

    const view = renderScoreEntry(makeProps())

    expect(view.result.current.showManualEntry).toBe(true)
  })

  it('does nothing with no score to take back', async () => {
    const view = renderScoreEntry(makeProps())

    await act(() => view.result.current.takeBackScore())

    expect(view.game.retractScore).not.toHaveBeenCalled()
  })

  it('opening entry again tells the table to hold on', async () => {
    const view = renderScoreEntry(submittedProps())

    await act(() => view.result.current.takeBackScore())

    expect(view.realtime.entryStatus).toHaveBeenLastCalledWith(ROOM_ID, 'typing', 2)
  })

  it('the override switch is saved with the draft, and adding cards keeps it', () => {
    const view = renderScoreEntry()
    openWithDraft(view, 'manual')

    act(() => view.result.current.savePendingDuplicateAllowed(true))
    expect(loadDraft(2).duplicateAllowed).toBe(true)
    // The draft is read at render, as a reload would read it.
    view.rerender(makeProps())
    expect(view.result.current.pendingDuplicateAllowed).toBe(true)
    act(() => view.result.current.savePendingDraft(CARDS))
    expect(loadDraft(2).duplicateAllowed).toBe(true)

    view.rerender(makeProps())
    act(() => view.result.current.savePendingDuplicateAllowed(false))
    expect(loadDraft(2)).toEqual({ source: 'manual', cards: CARDS })
  })

  it('saving the override with no entry or no draft does nothing', () => {
    const view = renderScoreEntry()

    act(() => view.result.current.savePendingDuplicateAllowed(true))
    expect(loadDraft(2)).toBeNull()

    act(() => view.result.current.openScoreEntry('manual'))
    act(() => view.result.current.savePendingDuplicateAllowed(true))
    expect(loadDraft(2)).toBeNull()
  })
})

describe('the game being reopened', () => {
  it('restores no stale draft and opens no entry', () => {
    const props = makeProps({ currentPlayer: makePlayer('p1', { has_submitted_round: true }) })
    const view = renderScoreEntry(props)
    saveDraft(2)

    view.rerender({ ...props, room: { ...props.room, status: 'finished' } })
    view.rerender({ ...props, room: { ...props.room, status: 'playing' } })

    expect(isEntryOpen(view)).toBe(false)
    expect(loadDraft(2)).toBeNull()
  })

  it('does not replay "Score submitted!"', async () => {
    const successSpy = vi.spyOn(toast, 'success')
    const props = makeProps()
    const view = renderScoreEntry(props)
    openWithDraft(view, 'manual')
    await submit(view)

    const submitted = { ...props, currentPlayer: makePlayer('p1', { has_submitted_round: true }) }
    view.rerender({ ...submitted, room: { ...props.room, status: 'finished' } })
    expect(successSpy).toHaveBeenCalledTimes(1)

    view.rerender({ ...submitted, room: { ...props.room, status: 'playing', is_edit_mode: true } })
    view.rerender({ ...submitted, room: { ...props.room, status: 'finished' } })

    expect(successSpy).toHaveBeenCalledTimes(1)
  })
})

// --- Entering-cards signal --------------------------
// The open entry is what tells the room I am entering. makeProps puts the room in round 2.

describe('entry status', () => {
  it('opening manual entry announces typing for the round, and closing it clears that', () => {
    const view = renderScoreEntry()
    expect(view.realtime.entryStatus).not.toHaveBeenCalled()

    act(() => view.result.current.openScoreEntry('manual'))
    expect(view.realtime.entryStatus).toHaveBeenLastCalledWith(ROOM_ID, 'typing', 2)

    act(() => view.result.current.closeScoreEntry())
    expect(view.realtime.entryStatus).toHaveBeenLastCalledWith(ROOM_ID, null, 2)
  })

  it('startScanning announces scanning for the open entry', () => {
    const view = renderScoreEntry()
    act(() => view.result.current.openScoreEntry('scanner'))

    act(() => view.result.current.startScanning())

    expect(view.realtime.entryStatus).toHaveBeenLastCalledWith(ROOM_ID, 'scanning', 2)
  })

  it('a submitted score clears the announcement', async () => {
    const view = renderScoreEntry()
    act(() => view.result.current.openScoreEntry('manual'))

    await submit(view)

    expect(view.realtime.entryStatus).toHaveBeenLastCalledWith(ROOM_ID, null, 2)
  })

  it('announces nothing when no entry is open', () => {
    const view = renderScoreEntry()

    act(() => view.result.current.startScanning())

    expect(view.realtime.entryStatus).not.toHaveBeenCalled()
  })
})

// --- Game modes (X41) --------------------------------------------------------------

describe('the mode of the room', () => {
  it('sends the mode the score was worked out under', async () => {
    const view = renderScoreEntry(makeProps({ room: makeRoom({ current_round: 2, game_mode: 'vengeance' }) }))
    openWithDraft(view, 'manual')

    await submit(view)

    expect(view.game.submitScore).toHaveBeenCalledWith(ROOM_ID, expect.objectContaining({ game_mode: 'vengeance' }))
  })

  it('reads a room with no mode as classic', async () => {
    const view = renderScoreEntry()
    openWithDraft(view, 'manual')

    await submit(view)

    expect(view.game.submitScore).toHaveBeenCalledWith(ROOM_ID, expect.objectContaining({ game_mode: 'classic' }))
  })

  it('tells the player when the bust could not be sent again', async () => {
    const errorSpy = vi.spyOn(toast, 'error')
    const modeChanged = conflict({ code: 'mode_changed', game_mode: 'vengeance' })
    const view = renderScoreEntry(makeProps(), {
      game: { submitScore: () => Promise.reject(modeChanged) },
    })

    await act(() => view.result.current.bust())

    expect(view.game.submitScore).toHaveBeenCalledTimes(2)
    expect(errorSpy).toHaveBeenCalledWith('The game mode changed and your bust wasn\'t saved. Please try again.')
  })
})
