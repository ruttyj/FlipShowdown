// useHostActions.
import { act } from '@testing-library/react'
import { toast } from 'sonner'
import { describe, expect, it, vi } from 'vitest'
import { useHostActions } from '@/pages/gameRoom/useHostActions'
import { makePlayer, makeRoom, renderGameHook, ROOM_ID } from '../fixtures/renderGameHook.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

const PLAYERS = [
  makePlayer('p1', { is_host: true }),
  makePlayer('p2', { turn_order: 1 }),
  makePlayer('p3', { turn_order: 2 }),
]
const SCORE = { player_id: 'p2', round_number: 1, cards: [], base_sum: 0, final_score: 0 }

function renderActions({ room = makeRoom(), isHost = true, ...options } = {}) {
  return renderGameHook(
    (fixture) => useHostActions({ room, players: PLAYERS, isHost, ...fixture }),
    options,
  )
}

function apiError(status, code) {
  return Object.assign(new Error(code), { status, data: { code } })
}

/** Each action with the arguments to call it with, and the game call it makes. */
const ACTIONS = [
  ['kick', ['p2'], 'kick'],
  ['makeHost', ['p2'], 'makeHost'],
  ['reorder', [['p2', 'p1', 'p3']], 'reorder'],
  ['setFirstPlayer', ['p2'], 'reorder'],
  ['setGamesWon', [{ p1: 1 }], 'setGamesWon'],
  ['setGameMode', ['vengeance'], 'setGameMode'],
  ['start', [], 'start'],
  ['forceNextRound', [], 'forceNextRound'],
  ['setEditMode', [true], 'setEditMode'],
  ['editScore', [SCORE], 'editScore'],
  ['endGame', [], 'endGame'],
  ['playAgain', [], 'playAgain'],
  ['closeRoom', [], 'closeRoom'],
  ['deleteRoom', [], 'deleteRoom'],
]

describe('reopenGame (X45)', () => {
  function renderReopen(room, answers = [true]) {
    return renderGameHook((fixture) => useHostActions({ room, players: [], isHost: true, ...fixture }), { answers })
  }

  it('asks first, then reopens and refetches', async () => {
    const view = renderReopen(makeRoom({ status: 'finished', finish_reason: 'max_score' }))

    await act(() => view.result.current.reopenGame())

    expect(view.confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Reopen Game?',
      confirmText: 'Reopen Game',
      description: expect.stringContaining('The win is taken back until the game finishes again.'),
    }))
    expect(view.game.reopenGame).toHaveBeenCalledWith(ROOM_ID)
    expect(view.refetch).toHaveBeenCalled()
  })

  it('does not mention a win when the game was ended by hand', async () => {
    const view = renderReopen(makeRoom({ status: 'finished', finish_reason: 'ended' }))

    await act(() => view.result.current.reopenGame())

    expect(view.confirm.mock.calls[0][0].description).not.toContain('win')
  })

  it('does nothing when cancelled', async () => {
    const view = renderReopen(makeRoom({ status: 'finished' }), [false])

    await act(() => view.result.current.reopenGame())

    expect(view.game.reopenGame).not.toHaveBeenCalled()
  })

  it('does nothing for a guest', async () => {
    const room = makeRoom({ status: 'finished' })
    const view = renderGameHook((fixture) => useHostActions({ room, players: [], isHost: false, ...fixture }))

    await act(() => view.result.current.reopenGame())

    expect(view.confirm).not.toHaveBeenCalled()
    expect(view.game.reopenGame).not.toHaveBeenCalled()
  })
})

describe('not allowed', () => {
  it.each(ACTIONS)('%s does nothing for a non-host', async (name, args, apiName) => {
    const view = renderActions({ isHost: false })

    const result = await act(() => view.result.current[name](...args))

    expect(result).toBeUndefined()
    expect(view.game[apiName]).not.toHaveBeenCalled()
    expect(view.confirm).not.toHaveBeenCalled()
  })

  it.each(ACTIONS)('%s does nothing without a room', async (name, args, apiName) => {
    const view = renderActions({ room: null })

    const result = await act(() => view.result.current[name](...args))

    expect(result).toBeUndefined()
    expect(view.game[apiName]).not.toHaveBeenCalled()
    expect(view.confirm).not.toHaveBeenCalled()
  })
})

describe('confirm first', () => {
  const CONFIRMED = [
    ['kick', ['p2']],
    ['makeHost', ['p2']],
    ['endGame', []],
    ['playAgain', []],
    ['closeRoom', []],
    ['deleteRoom', []],
    ['forceNextRound', []],
  ]

  it.each(CONFIRMED)('%s sends nothing when cancelled', async (name, args) => {
    const view = renderActions({ answers: [false] })

    const result = await act(() => view.result.current[name](...args))

    expect(view.confirm).toHaveBeenCalledTimes(1)
    expect(result).toBeUndefined()
    for (const action of Object.values(view.game)) {
      expect(action).not.toHaveBeenCalled()
    }
    expect(view.navigate).not.toHaveBeenCalled()
  })

  it.each(CONFIRMED)('%s sends the action once confirmed', async (name, args) => {
    const view = renderActions({ answers: [true] })

    await act(() => view.result.current[name](...args))

    expect(view.game[name]).toHaveBeenCalledTimes(1)
    expect(view.game[name].mock.calls[0][0]).toBe(ROOM_ID)
  })

  it('make host names the new host in the prompt', async () => {
    const view = renderActions({ answers: [false] })

    await act(() => view.result.current.makeHost('p2'))

    expect(view.confirm.mock.calls[0][0].description).toContain('p2 will become the host')
  })

  it('make host falls back to a generic name for an unknown player', async () => {
    const view = renderActions({ answers: [false] })

    await act(() => view.result.current.makeHost('ghost'))

    expect(view.confirm.mock.calls[0][0].description).toContain('This player will become the host')
  })
})

describe('kick', () => {
  it('sends the player id and refetches', async () => {
    const view = renderActions({ answers: [true] })

    await act(() => view.result.current.kick('p2'))

    expect(view.game.kick).toHaveBeenCalledWith(ROOM_ID, 'p2')
    expect(view.refetch).toHaveBeenCalled()
  })

  it('treats player_not_found as done', async () => {
    const view = renderActions({
      answers: [true],
      game: { kick: () => Promise.reject(apiError(404, 'player_not_found')) },
    })

    const result = await act(() => view.result.current.kick('p2'))

    expect(result).toMatchObject({ alreadyDone: true })
  })

  it('does not treat other errors as done', async () => {
    const view = renderActions({
      answers: [true],
      game: { kick: () => Promise.reject(apiError(500, 'server_error')) },
    })

    const result = await act(() => view.result.current.kick('p2'))

    expect(result).toBeUndefined()
  })
})

describe('forceNextRound', () => {
  it('sends the round the host was looking at, not the round after the confirm', async () => {
    let room = makeRoom({ current_round: 3 })
    const view = renderGameHook(
      (fixture) => useHostActions({ room, players: PLAYERS, isHost: true, ...fixture }),
      { answers: [true] },
    )
    view.confirm.mockImplementationOnce(async () => {
      room = makeRoom({ current_round: 4 })
      view.rerender()
      return true
    })

    await act(() => view.result.current.forceNextRound())

    expect(view.game.forceNextRound).toHaveBeenCalledWith(ROOM_ID, 3)
  })

  it('treats round_mismatch as done', async () => {
    const view = renderActions({
      answers: [true],
      game: { forceNextRound: () => Promise.reject(apiError(409, 'round_mismatch')) },
    })

    const result = await act(() => view.result.current.forceNextRound())

    expect(result).toMatchObject({ alreadyDone: true })
  })
})

describe('setFirstPlayer', () => {
  it('sends the chosen player first and the others in their order', async () => {
    const view = renderActions()

    await act(() => view.result.current.setFirstPlayer('p3'))

    expect(view.game.reorder).toHaveBeenCalledWith(ROOM_ID, ['p3', 'p1', 'p2'])
  })
})

describe('closeRoom and deleteRoom', () => {
  it.each(['closeRoom', 'deleteRoom'])('%s navigates to Home on success', async (name) => {
    const view = renderActions({ answers: [true] })

    await act(() => view.result.current[name]())

    expect(view.navigate).toHaveBeenCalledTimes(1)
    expect(view.navigate.mock.calls[0][0]).toMatch(/Home/)
    expect(view.refetch).not.toHaveBeenCalled()
  })

  it.each(['closeRoom', 'deleteRoom'])('%s does not navigate when the call fails', async (name) => {
    const view = renderActions({ answers: [true], game: { [name]: () => Promise.reject(new Error('boom')) } })

    await act(() => view.result.current[name]())

    expect(view.navigate).not.toHaveBeenCalled()
  })

  it('deleteRoom treats room_not_found as done and navigates', async () => {
    const view = renderActions({
      answers: [true],
      game: { deleteRoom: () => Promise.reject(apiError(404, 'room_not_found')) },
    })

    await act(() => view.result.current.deleteRoom())

    expect(view.navigate).toHaveBeenCalledTimes(1)
  })
})

describe('pass-through', () => {
  it.each([true, false])('setEditMode(%s) passes the flag to the API', async (on) => {
    const view = renderActions()

    await act(() => view.result.current.setEditMode(on))

    expect(view.game.setEditMode).toHaveBeenCalledWith(ROOM_ID, on)
  })

  it('editScore passes the score to the API', async () => {
    const view = renderActions()

    await act(() => view.result.current.editScore(SCORE))

    expect(view.game.editScore).toHaveBeenCalledWith(ROOM_ID, SCORE)
  })

  it('start, setGamesWon and reorder pass their arguments', async () => {
    const view = renderActions()

    await act(() => view.result.current.start())
    await act(() => view.result.current.setGamesWon({ p1: 2 }))
    await act(() => view.result.current.reorder(['p2', 'p1', 'p3']))

    expect(view.game.start).toHaveBeenCalledWith(ROOM_ID)
    expect(view.game.setGamesWon).toHaveBeenCalledWith(ROOM_ID, { p1: 2 })
    expect(view.game.reorder).toHaveBeenCalledWith(ROOM_ID, ['p2', 'p1', 'p3'])
  })
})

describe('setGameMode (X41)', () => {
  it('applies at once while waiting, with no question', async () => {
    const view = renderActions({ room: makeRoom({ status: 'waiting' }) })

    await act(() => view.result.current.setGameMode('vengeance'))

    expect(view.confirm).not.toHaveBeenCalled()
    expect(view.game.setGameMode).toHaveBeenCalledWith(ROOM_ID, 'vengeance')
    expect(view.refetch).toHaveBeenCalled()
  })

  it('asks first during the first round, naming the mode', async () => {
    const view = renderActions({ answers: [true] })

    await act(() => view.result.current.setGameMode('vengeance'))

    expect(view.confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Switch to Vengeance?',
      description: 'Anyone entering cards will have them re-scored.',
    }))
    expect(view.game.setGameMode).toHaveBeenCalledWith(ROOM_ID, 'vengeance')
  })

  it('sends nothing when the question is cancelled', async () => {
    const view = renderActions({ answers: [false] })

    await act(() => view.result.current.setGameMode('vengeance'))

    expect(view.game.setGameMode).not.toHaveBeenCalled()
  })

  it('explains mode_locked and refetches, so the screen learns about the score', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => 'toast-id')
    const view = renderActions({
      room: makeRoom({ status: 'waiting' }),
      game: { setGameMode: () => Promise.reject(apiError(409, 'mode_locked')) },
    })

    await act(() => view.result.current.setGameMode('vengeance'))

    expect(error).toHaveBeenCalledWith('Someone already scored, so the mode is locked')
    expect(view.refetch).toHaveBeenCalled()
    error.mockRestore()
  })

  it('any other failure uses the normal action error toast', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => 'toast-id')
    const view = renderActions({
      room: makeRoom({ status: 'waiting' }),
      game: { setGameMode: () => Promise.reject(new Error('server down')) },
    })

    await act(() => view.result.current.setGameMode('vengeance'))

    expect(error).toHaveBeenCalledWith('Change game mode failed: server down')
    error.mockRestore()
  })
})

describe('editScore and a changed mode (X41)', () => {
  it('resolves undefined so the editor stays open, refetches and says why', async () => {
    const info = vi.spyOn(toast, 'info').mockImplementation(() => 'toast-id')
    const view = renderActions({ game: { editScore: () => Promise.reject(apiError(409, 'mode_changed')) } })

    const result = await act(() => view.result.current.editScore(SCORE))

    expect(result).toBeUndefined()
    expect(view.refetch).toHaveBeenCalled()
    expect(info).toHaveBeenCalledWith('The game mode changed, so check this score and save again')
    info.mockRestore()
  })
})
