// useScoreEntry in Brutal (X43): the Flip 7 choice through drafts and submits, Add a minus card, and
// the minus cards sent with a bust.
import { act, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { calculateFlip7Score } from '@/lib/flip7Scoring'
import { loadPendingCards, pendingCardsScope, savePendingCards } from '@/lib/pendingCards'
import { useScoreEntry } from '@/pages/gameRoom/useScoreEntry'
import { makePlayer, makeRoom, renderGameHook, ROOM_ID } from '../fixtures/renderGameHook.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

afterEach(() => {
  vi.restoreAllMocks()
})

const SEVEN_CARDS = [1, 2, 3, 4, 5, 6, 7].map((value) => ({ type: 'number', value: String(value) }))
const ROUND = 2

function makeProps(overrides = {}) {
  return {
    room: makeRoom({ current_round: ROUND, game_mode: 'brutal' }),
    currentPlayer: makePlayer('p1'),
    roundScores: [],
    isHost: false,
    ...overrides,
  }
}

function renderScoreEntry(props = makeProps(), options = {}) {
  const setEditMode = vi.fn(async () => ({ ok: true }))
  return renderGameHook(
    (fixture, hookProps) => useScoreEntry({ ...hookProps, ...fixture }),
    { ...options, initialProps: props },
  )
}

function loadDraft() {
  return loadPendingCards(sessionStorage, pendingCardsScope(ROOM_ID, 1), ROUND)
}

function storedBust(fields = {}) {
  return {
    id: 's1',
    player_id: 'p1',
    round_number: ROUND,
    cards: [],
    base_sum: 0,
    final_score: 0,
    busted: true,
    updated_date: '2026-01-01T00:00:00.000Z',
    ...fields,
  }
}

// --- The Flip 7 choice ------------------------------------------------------------

describe('the Flip 7 choice', () => {
  it('goes out with the score', async () => {
    const view = renderScoreEntry()
    act(() => view.result.current.openScoreEntry('manual'))

    await act(() => view.result.current.submitScore({
      cards: SEVEN_CARDS,
      ...calculateFlip7Score(SEVEN_CARDS, 'brutal', { flip7Attack: true }),
      flip7AttackPlayerId: 'p2',
    }))

    expect(view.game.submitScore).toHaveBeenCalledWith(ROOM_ID, expect.objectContaining({
      final_score: 28,
      flip7_attack_player_id: 'p2',
      game_mode: 'brutal',
    }))
  })

  it('is kept in the draft, so a reload restores it', () => {
    const view = renderScoreEntry()
    act(() => view.result.current.openScoreEntry('manual'))
    act(() => view.result.current.savePendingDraft(SEVEN_CARDS))

    act(() => view.result.current.savePendingAttack('p2'))

    expect(loadDraft()).toEqual({ source: 'manual', cards: SEVEN_CARDS, flip7AttackPlayerId: 'p2' })
    view.rerender(makeProps())
    expect(view.result.current.pendingAttackPlayerId).toBe('p2')
  })

  it('survives more cards being typed', () => {
    const view = renderScoreEntry()
    act(() => view.result.current.openScoreEntry('manual'))
    act(() => view.result.current.savePendingDraft(SEVEN_CARDS))
    act(() => view.result.current.savePendingAttack('p2'))

    act(() => view.result.current.savePendingDraft(SEVEN_CARDS.slice(0, 6)))

    expect(loadDraft().flip7AttackPlayerId).toBe('p2')
  })

  it('is not stored once it goes back to +15, and lives beside the override', () => {
    const view = renderScoreEntry()
    act(() => view.result.current.openScoreEntry('manual'))
    act(() => view.result.current.savePendingDraft(SEVEN_CARDS))
    act(() => view.result.current.savePendingDuplicateAllowed(true))
    act(() => view.result.current.savePendingAttack('p2'))
    expect(loadDraft()).toEqual({ source: 'manual', cards: SEVEN_CARDS, duplicateAllowed: true, flip7AttackPlayerId: 'p2' })

    act(() => view.result.current.savePendingAttack(null))

    expect(loadDraft()).toEqual({ source: 'manual', cards: SEVEN_CARDS, duplicateAllowed: true })
  })

  it('does nothing with no draft or no entry open', () => {
    const view = renderScoreEntry()

    act(() => view.result.current.savePendingAttack('p2'))
    expect(loadDraft()).toBeNull()

    act(() => view.result.current.openScoreEntry('manual'))
    act(() => view.result.current.savePendingAttack('p2'))
    expect(loadDraft()).toBeNull()
  })

  it('Change score brings it back with the cards, so it isn\'t silently +15', async () => {
    const stored = { id: 's1', player_id: 'p1', round_number: ROUND, cards: SEVEN_CARDS, final_score: 28, flip7_attack_player_id: 'p2' }
    const view = renderScoreEntry(makeProps({
      roundScores: [stored],
      currentPlayer: makePlayer('p1', { has_submitted_round: true }),
    }))

    await act(() => view.result.current.takeBackScore())

    expect(loadDraft()).toEqual({ source: 'manual', cards: SEVEN_CARDS, flip7AttackPlayerId: 'p2' })
    expect(view.result.current.showManualEntry).toBe(true)
    expect(view.result.current.pendingAttackPlayerId).toBe('p2')
  })

  // Without the override the editor would score these cards as a duplicate bust and drop the attack.
  it('a host restoring an older round\'s vouched hand gets the override in the editor', async () => {
    const cards = [...SEVEN_CARDS, { type: 'number', value: '7' }]
    savePendingCards(sessionStorage, pendingCardsScope(ROOM_ID, 1), ROUND - 1, {
      source: 'manual',
      cards,
      duplicateAllowed: true,
      flip7AttackPlayerId: 'p2',
    })

    const view = renderScoreEntry(makeProps({ isHost: true }), { answers: ['confirm'] })

    await waitFor(() => expect(view.result.current.editorStart).not.toBeNull())
    expect(view.result.current.editorStart).toMatchObject({
      round_number: ROUND - 1,
      duplicate_allowed: true,
      flip7_attack_player_id: 'p2',
    })
  })

})

// --- Add a minus card -------------------------------------------------------------

describe('Add a minus card', () => {
  function bustedProps(score) {
    return makeProps({
      roundScores: [score],
      currentPlayer: makePlayer('p1', { has_submitted_round: true }),
    })
  }

  it('re-submits with the card, still busted, scored as the minus cards', async () => {
    const view = renderScoreEntry(bustedProps(storedBust()))

    await act(() => view.result.current.addMinusCard('6'))

    expect(view.game.submitScore).toHaveBeenCalledWith(ROOM_ID, {
      round_number: ROUND,
      cards: [{ type: 'subtractor', value: '6' }],
      base_sum: 0,
      final_score: -6,
      busted: true,
      game_mode: 'brutal',
    })
  })

  it('adds to what the hand already holds, keeping a duplicate bust\'s cards', async () => {
    const cards = [{ type: 'number', value: '5' }, { type: 'number', value: '5' }, { type: 'subtractor', value: '2' }]
    const view = renderScoreEntry(bustedProps(storedBust({ cards, final_score: -2 })))

    await act(() => view.result.current.addMinusCard('4'))

    const sent = view.game.submitScore.mock.calls[0][1]
    expect(sent.cards).toHaveLength(4)
    expect(sent.final_score).toBe(-6)
    expect(sent.busted).toBe(true)
  })

  it('a newer stored score wins over what was last sent, as the host may have edited it', async () => {
    const saved = storedBust({
      cards: [{ type: 'subtractor', value: '6' }],
      final_score: -6,
      updated_date: '2026-01-01T00:00:05.000Z',
    })
    const view = renderScoreEntry(bustedProps(storedBust()), {
      game: { submitScore: async () => ({ already_applied: false, round_score: saved }) },
    })
    await act(() => view.result.current.addMinusCard('6'))

    view.rerender(bustedProps(storedBust({ updated_date: '2026-01-01T00:00:09.000Z' })))
    await act(() => view.result.current.addMinusCard('2'))

    expect(view.game.submitScore.mock.calls[1][1].final_score).toBe(-2)
  })

  it('a bust taken back and made again starts from its own cards', async () => {
    const saved = storedBust({
      cards: [{ type: 'subtractor', value: '6' }],
      final_score: -6,
      updated_date: '2026-01-01T00:00:05.000Z',
    })
    const view = renderScoreEntry(bustedProps(storedBust()), {
      game: { submitScore: async () => ({ already_applied: false, round_score: saved }) },
    })
    await act(() => view.result.current.addMinusCard('6'))

    view.rerender(bustedProps(storedBust({ id: 's2' })))
    await act(() => view.result.current.addMinusCard('2'))

    expect(view.game.submitScore.mock.calls[1][1].final_score).toBe(-2)
  })

  it('no "Score submitted!" for it later: the round moving on isn\'t about this', async () => {
    const success = vi.spyOn(toast, 'success').mockImplementation(() => 'id')
    const props = bustedProps(storedBust())
    const view = renderScoreEntry(props)

    await act(() => view.result.current.addMinusCard('6'))
    view.rerender({ ...props, room: { ...props.room, current_round: ROUND + 1 } })

    expect(success).not.toHaveBeenCalled()
  })

  // The toast's Undo goes straight to the retract, with no draft, so it would delete the added card.
  it('dismisses the Bust tile\'s Undo toast, which would throw the card away', async () => {
    vi.spyOn(toast, 'info').mockImplementation(() => 'bust-toast')
    const dismiss = vi.spyOn(toast, 'dismiss').mockImplementation(() => 'id')
    const view = renderScoreEntry()
    await act(() => view.result.current.bust())
    view.rerender(bustedProps(storedBust()))
    expect(dismiss).not.toHaveBeenCalled()

    await act(() => view.result.current.addMinusCard('6'))

    expect(dismiss).toHaveBeenCalledWith('bust-toast')
  })

  it('does nothing with no stored score yet', async () => {
    const view = renderScoreEntry(makeProps())

    await act(() => view.result.current.addMinusCard('6'))

    expect(view.game.submitScore).not.toHaveBeenCalled()
  })

  it('a failure leaves everything as it was', async () => {
    vi.spyOn(toast, 'error').mockImplementation(() => 'id')
    const view = renderScoreEntry(bustedProps(storedBust()), {
      game: { submitScore: () => Promise.reject(new Error('offline')) },
    })

    await act(() => view.result.current.addMinusCard('6'))

    expect(view.result.current.showManualEntry).toBe(false)
  })
})

// --- The bust ----------------------------------------------------------------------

describe('the Bust tile in Brutal', () => {
  it('asks no second confirm, as the minus card step already did', async () => {
    const view = renderScoreEntry()

    await act(() => view.result.current.bust())

    expect(view.confirm).not.toHaveBeenCalled()
    expect(view.game.submitScore).toHaveBeenCalled()
  })

  it('sends a declared bust of 0 with no minus cards', async () => {
    const view = renderScoreEntry()

    await act(() => view.result.current.bust())

    expect(view.game.submitScore).toHaveBeenCalledWith(ROOM_ID, expect.objectContaining({
      cards: [],
      final_score: 0,
      busted: true,
      game_mode: 'brutal',
    }))
  })

  // The last player's bust closes the round, so these can't be added afterwards.
  it('sends the chosen minus cards with the bust', async () => {
    const view = renderScoreEntry()

    await act(() => view.result.current.bust(['6', '2']))

    expect(view.game.submitScore).toHaveBeenCalledWith(ROOM_ID, expect.objectContaining({
      cards: [{ type: 'subtractor', value: '6' }, { type: 'subtractor', value: '2' }],
      final_score: -8,
      busted: true,
    }))
  })

  it('offers no Undo toast with minus cards, as it keeps no draft and would lose them', async () => {
    const info = vi.spyOn(toast, 'info').mockImplementation(() => 'id')
    const view = renderScoreEntry()

    await act(() => view.result.current.bust(['6']))

    expect(info).not.toHaveBeenCalled()
  })

})
