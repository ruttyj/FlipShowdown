// Score entry against a real room (testRoom.jsx): real useGameRoom and useRoomData, the server's real
// replies, and the realtime events and HTTP replies arriving in either order.
import { act, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRoomData } from '@/hooks/useRoomData'
import { loadPendingCards, pendingCardsScope } from '@/lib/pendingCards'
import { useGameRoom } from '@/pages/gameRoom/useGameRoom'
import { useScoreEntry } from '@/pages/gameRoom/useScoreEntry'
import { renderGameHook } from '../fixtures/renderGameHook.jsx'
import { createTestRoom } from '../fixtures/testRoom.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

function isEntryOpen(view) {
  const entry = view.result.current.scoreEntry ?? view.result.current
  return entry.showScanner || entry.showManualEntry
}

const HAND = { cards: [{ value: '7', type: 'number' }], baseSum: 7, finalScore: 7 }
const SEVEN_CARDS = [1, 2, 3, 4, 5, 6, 7].map((value) => ({ type: 'number', value: String(value) }))
const SUBMITTED_MESSAGE = 'Score submitted!'

let room

beforeEach(() => {
  localStorage.setItem('flip7_sound_muted', 'true')
  room = createTestRoom({ players: ['p1', 'p2'], me: 'p1' })
})

afterEach(() => {
  room.close()
})

async function renderInRoom() {
  const view = renderGameHook(() => useGameRoom(), { url: room.url, testRoom: room })
  await waitFor(() => expect(view.result.current.table.currentPlayer).not.toBeNull())
  return view
}

function submittedToasts(successSpy) {
  return successSpy.mock.calls.filter(([message]) => message === SUBMITTED_MESSAGE)
}

// --- X12: whichever arrives first ------------------------------------------------

describe('"Score submitted!" (X12)', () => {
  it('stays quiet when others still have to submit, though the room update beat the reply and the round advances later', async () => {
    const successSpy = vi.spyOn(toast, 'success')
    const view = await renderInRoom()
    act(() => view.result.current.scoreEntry.openScoreEntry('manual'))

    const replies = room.holdReplies()
    let submit
    await act(async () => {
      submit = view.result.current.scoreEntry.submitScore(HAND)
    })
    await waitFor(() => expect(view.result.current.table.currentPlayer.has_submitted_round).toBe(true))
    await act(async () => {
      replies.release()
      await submit
    })

    await act(async () => {
      room.as('p2', 'submit-score', room.scoreBody(1))
    })
    await waitFor(() => expect(view.result.current.table.room.current_round).toBe(2))

    expect(submittedToasts(successSpy)).toHaveLength(0)
  })

  it('shows when my submit completed the round, though the room update beat the reply', async () => {
    const successSpy = vi.spyOn(toast, 'success')
    room.as('p2', 'submit-score', room.scoreBody(1))
    const view = await renderInRoom()
    act(() => view.result.current.scoreEntry.openScoreEntry('manual'))

    const replies = room.holdReplies()
    let submit
    await act(async () => {
      submit = view.result.current.scoreEntry.submitScore(HAND)
    })
    await waitFor(() => expect(view.result.current.table.room.current_round).toBe(2))
    await act(async () => {
      replies.release()
      await submit
    })

    expect(submittedToasts(successSpy)).toHaveLength(1)
  })

  it('shows once when the reply came first and the round completes with its update', async () => {
    const successSpy = vi.spyOn(toast, 'success')
    room.as('p2', 'submit-score', room.scoreBody(1))
    const view = await renderInRoom()
    act(() => view.result.current.scoreEntry.openScoreEntry('manual'))

    const events = room.holdEvents()
    await act(() => view.result.current.scoreEntry.submitScore(HAND))
    await act(async () => {
      events.release()
    })
    await waitFor(() => expect(view.result.current.table.room.current_round).toBe(2))

    expect(submittedToasts(successSpy)).toHaveLength(1)
  })
})

// --- The room's real conflicts ----------------------------------------------------
// useScoreEntry on the real room data, with the fixture's answer queue for its prompts. Another
// device's move with events held is a room that has moved on where this client hasn't heard yet.

function useRoomScoreEntry(fixture) {
  const data = useRoomData(room.code)
  const entry = useScoreEntry({
    room: data.room,
    currentPlayer: data.myPlayer,
    roundScores: data.roundScores,
    isHost: data.isHost,
    ...fixture,
  })
  return { ...entry, data }
}

async function renderScoreEntry({ me = 'p1', answers = [], gameMode } = {}) {
  room.close()
  room = createTestRoom({ players: ['p1', 'p2'], me, gameMode })
  const view = renderGameHook(useRoomScoreEntry, { url: room.url, testRoom: room, answers })
  await waitFor(() => expect(view.result.current.data.myPlayer).not.toBeNull())
  return view
}

/** A host's other device acts; this client doesn't hear of it. Returns the held events. */
function moveRoomUnheard(actionName = 'force-next-round', body = { round_number: 1 }) {
  const events = room.holdEvents()
  room.as('p1', actionName, body)
  return events
}

async function run(view, intent, ...args) {
  let outcome
  await act(async () => {
    outcome = await view.result.current[intent](...args)
  })
  return outcome
}

async function hearScore(view) {
  await waitFor(() => expect(view.result.current.data.roundScores.length).toBeGreaterThan(0))
}

function draftOf(roundNumber) {
  return loadPendingCards(sessionStorage, pendingCardsScope(room.id, 1), roundNumber)
}

describe('a score sent to a room that has moved on', () => {
  it('a finished game closes the entry and drops the draft', async () => {
    const view = await renderScoreEntry()
    act(() => view.result.current.openScoreEntry('scanner'))
    act(() => view.result.current.savePendingDraft(HAND.cards))
    moveRoomUnheard('end-game', {})

    const outcome = await run(view, 'submitScore', HAND)

    expect(outcome).toEqual({ kind: 'finished' })
    expect(isEntryOpen(view)).toBe(false)
    expect(draftOf(1)).toBeNull()
  })

  it('a bust that went in late opens the editor with Bust on for the host', async () => {
    const view = await renderScoreEntry({ answers: ['confirm'] })
    moveRoomUnheard()

    const outcome = await run(view, 'bust')

    expect(outcome.kind).toBe('round_moved')
    expect(outcome.currentRound).toBe(2)
    expect(outcome.storedScore.final_score).toBe(0)
    expect(view.result.current.editorStart).toEqual({
      player_id: room.player('p1').id,
      round_number: 1,
      cards: [],
      busted: true,
    })
  })

  it('a late score with an attack reaches the host\'s editor with the attack', async () => {
    const view = await renderScoreEntry({ gameMode: 'brutal', answers: ['confirm'] })
    act(() => view.result.current.openScoreEntry('manual'))
    moveRoomUnheard()

    await run(view, 'submitScore', { cards: SEVEN_CARDS, baseSum: 28, finalScore: 28, flip7AttackPlayerId: 'p2-id' })

    expect(view.result.current.editorStart).toMatchObject({ round_number: 1, flip7_attack_player_id: 'p2-id' })
  })

  it('a mode change keeps the entry and its draft, and asks for a refetch', async () => {
    const view = await renderScoreEntry()
    act(() => view.result.current.openScoreEntry('manual'))
    act(() => view.result.current.savePendingDraft(HAND.cards))
    const events = moveRoomUnheard('set-game-mode', { game_mode: 'vengeance' })

    const outcome = await run(view, 'submitScore', HAND)

    expect(outcome).toEqual({ kind: 'mode_changed', gameMode: 'vengeance' })
    expect(view.result.current.showManualEntry).toBe(true)
    expect(draftOf(1).cards).toEqual(HAND.cards)
    expect(view.refetch).toHaveBeenCalled()
    await act(async () => events.release())
    expect(view.result.current.data.room.game_mode).toBe('vengeance')
  })

  it('a bust is sent again under the new mode, and lands', async () => {
    const view = await renderScoreEntry()
    moveRoomUnheard('set-game-mode', { game_mode: 'vengeance' })

    const outcome = await run(view, 'bust')

    expect(view.game.submitScore).toHaveBeenCalledTimes(2)
    expect(view.game.submitScore.mock.calls[1][1].game_mode).toBe('vengeance')
    expect(outcome.kind).toBe('saved')
    expect(outcome.response.round_score.busted).toBe(true)
  })

  it('a brutal bust sent again keeps its minus cards, worth 0 in the new mode', async () => {
    const view = await renderScoreEntry({ gameMode: 'brutal' })
    moveRoomUnheard('set-game-mode', { game_mode: 'vengeance' })

    const outcome = await run(view, 'bust', ['6'])

    expect(outcome.response.round_score).toMatchObject({
      cards: [{ type: 'subtractor', value: '6' }],
      final_score: 0,
    })
  })
})

describe('the Undo toast after the room moved on', () => {
  async function bustThenUndo({ me, answers, moveWith }) {
    const infoSpy = vi.spyOn(toast, 'info')
    const view = await renderScoreEntry({ me, answers })
    await run(view, 'bust')
    const undo = infoSpy.mock.calls.at(-1)[1].action.onClick
    moveRoomUnheard(...moveWith)
    await act(async () => {
      await undo()
    })
    return { view, infoSpy }
  }

  const CLOSE_ROUND = ['force-next-round', { round_number: 1 }]
  const END_GAME = ['end-game', {}]

  it('tells a guest to ask the host when the round closed', async () => {
    const { view, infoSpy } = await bustThenUndo({ me: 'p2', moveWith: CLOSE_ROUND })

    expect(infoSpy).toHaveBeenLastCalledWith('Round closed. Ask the host to fix it')
    expect(view.ask).not.toHaveBeenCalled()
  })

  it('offers the host the score editor, on the bust as it stands', async () => {
    const { view } = await bustThenUndo({ answers: ['confirm'], moveWith: CLOSE_ROUND })

    expect(view.ask).toHaveBeenCalledWith(expect.objectContaining({ confirmText: 'Edit round 1' }))
    expect(view.result.current.editorStart).toEqual({
      player_id: room.player('p1').id,
      round_number: 1,
      cards: [],
      busted: true,
    })
  })

  it('opens nothing when the host keeps the score', async () => {
    const { view } = await bustThenUndo({ answers: ['cancel'], moveWith: CLOSE_ROUND })

    expect(view.result.current.editorStart).toBeNull()
  })

  it('tells a guest to ask the host when the game finished', async () => {
    const { infoSpy } = await bustThenUndo({ me: 'p2', moveWith: END_GAME })

    expect(infoSpy).toHaveBeenLastCalledWith('Round closed. Ask the host to fix it')
  })

  it('points the host at Reopen Game when the game finished', async () => {
    const { infoSpy } = await bustThenUndo({ moveWith: END_GAME })

    expect(infoSpy).toHaveBeenLastCalledWith('The game has finished. Use Reopen Game to fix this score')
  })
})

describe('taking a score back from a room that moved on', () => {
  async function submitted(options) {
    const view = await renderScoreEntry(options)
    act(() => view.result.current.openScoreEntry('manual'))
    await run(view, 'submitScore', HAND)
    await hearScore(view)
    return view
  }

  it('the round having closed drops the draft, and tells a guest to ask the host', async () => {
    const infoSpy = vi.spyOn(toast, 'info')
    const view = await submitted({ me: 'p2' })
    moveRoomUnheard()

    const outcome = await run(view, 'takeBackScore')

    expect(outcome.kind).toBe('round_moved')
    expect(infoSpy).toHaveBeenLastCalledWith('Round closed. Ask the host to fix it')
    expect(isEntryOpen(view)).toBe(false)
    expect(draftOf(1)).toBeNull()
  })

  it('the game having finished drops the draft too', async () => {
    const view = await submitted({ me: 'p2' })
    moveRoomUnheard('end-game', {})

    const outcome = await run(view, 'takeBackScore')

    expect(outcome).toEqual({ kind: 'finished' })
    expect(isEntryOpen(view)).toBe(false)
    expect(draftOf(1)).toBeNull()
  })

  it('a host too late to take an attack back gets it in the editor', async () => {
    const view = await renderScoreEntry({ gameMode: 'brutal', answers: ['confirm'] })
    const targetId = room.player('p2').id
    await act(async () => {
      room.as('p1', 'submit-score', room.scoreBody(1, {
        cards: SEVEN_CARDS,
        base_sum: 28,
        final_score: 28,
        flip7_attack_player_id: targetId,
      }))
    })
    await hearScore(view)
    const events = room.holdEvents()
    room.as('p2', 'submit-score', room.scoreBody(1))

    await run(view, 'takeBackScore')

    expect(view.result.current.editorStart).toMatchObject({ round_number: 1, flip7_attack_player_id: targetId })
    await act(async () => events.release())
  })
})

describe('Add a minus card against the real room', () => {
  async function busted(options = {}) {
    const view = await renderScoreEntry({ gameMode: 'brutal', ...options })
    await run(view, 'bust')
    await hearScore(view)
    return view
  }

  it('a second card before the room update arrives builds on the first, from the real reply', async () => {
    const view = await busted()
    const events = room.holdEvents()

    await run(view, 'addMinusCard', '6')
    await run(view, 'addMinusCard', '4')

    expect(room.server.records('RoundScore')[0].final_score).toBe(-10)
    await act(async () => events.release())
  })

  it('Undo bust straight after a card keeps that card, though the room data hasn\'t caught up', async () => {
    const view = await busted()
    const events = room.holdEvents()
    await run(view, 'addMinusCard', '6')

    await run(view, 'takeBackScore')

    expect(draftOf(1).cards).toEqual([{ type: 'subtractor', value: '6' }])
    expect(view.result.current.showManualEntry).toBe(true)
    await act(async () => events.release())
  })

  it('a guest who is too late is told to ask the host', async () => {
    const infoSpy = vi.spyOn(toast, 'info')
    const view = await busted({ me: 'p2' })
    moveRoomUnheard()

    await run(view, 'addMinusCard', '6')

    expect(infoSpy).toHaveBeenLastCalledWith('Round closed. Ask the host to fix it')
  })

  it('a host who is too late is offered the editor, on the bust that stands', async () => {
    const view = await busted({ answers: ['confirm'] })
    const events = room.holdEvents()
    room.as('p2', 'submit-score', room.scoreBody(1))

    await run(view, 'addMinusCard', '6')

    expect(view.result.current.editorStart).toMatchObject({ round_number: 1, busted: true })
    await act(async () => events.release())
  })

  it('a finished game says so', async () => {
    const infoSpy = vi.spyOn(toast, 'info')
    const view = await busted({ me: 'p2' })
    moveRoomUnheard('end-game', {})

    await run(view, 'addMinusCard', '6')

    expect(infoSpy).toHaveBeenLastCalledWith('Round closed. Ask the host to fix it')
  })
})
