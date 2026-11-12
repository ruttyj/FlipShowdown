// Smoke test for the renderGameHook fixture: the fake API, the confirm/ask queue, perform
// on the real useActionRunner, the router and the providers, each driven through real hooks.
import { act, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useAuth } from '@/lib/AuthContext'
import { useGameRoom } from '@/pages/gameRoom/useGameRoom'
import { useHostActions } from '@/pages/gameRoom/useHostActions'
import { GAME_ACTION_NAMES } from './fakeApi.jsx'
import { DEFAULT_USER, makePlayer, makeRoom, renderGameHook, ROOM_CODE } from './renderGameHook.jsx'

vi.mock('@/api/game', () => import('./fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('./fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('./fakeApi.jsx').then((fakes) => fakes.aiModule))

// --- Helpers ---------------------------------------------------------------------

function renderHostActions(options) {
  const room = makeRoom()
  const players = [makePlayer('p1', { is_host: true }), makePlayer('p2', { turn_order: 1 })]
  const view = renderGameHook(
    (fixture) => useHostActions({ room, players, isHost: true, ...fixture }),
    options,
  )
  return { room, view }
}

// --- Fake game API ---------------------------------------------------------------

test('the fake game API has a vi.fn() for every action of the real module', async () => {
  const actual = await vi.importActual('@/api/game')

  expect([...GAME_ACTION_NAMES].sort()).toEqual(Object.keys(actual.game).sort())
})

test('a confirmed kick calls the fake game API, then refetches through perform', async () => {
  const { room, view } = renderHostActions({ answers: [true] })

  let response
  await act(async () => {
    response = await view.result.current.kick('p2')
  })

  expect(view.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Kick Player?' }))
  expect(view.game.kick).toHaveBeenCalledWith(room.id, 'p2')
  expect(response).toEqual({ ok: true })
  expect(view.refetch).toHaveBeenCalledTimes(1)
  expect(view.busy()).toEqual({ kick: false })
})

test('an action override replaces the default response for that test only', async () => {
  const error = Object.assign(new Error('boom'), { status: 500 })
  const { view } = renderHostActions({ game: { start: () => Promise.reject(error) } })

  let response
  await act(async () => {
    response = await view.result.current.start()
  })

  expect(view.game.start).toHaveBeenCalledTimes(1)
  expect(response).toBeUndefined()
  expect(view.refetch).not.toHaveBeenCalled()
})

test('overrides from an earlier render are gone on the next one', async () => {
  const { view } = renderHostActions()

  await expect(view.game.start()).resolves.toEqual({ ok: true })
})

// --- Confirm and ask queue -------------------------------------------------------

test('a declined confirm stops the action before it reaches the API', async () => {
  const { view } = renderHostActions({ answers: [false] })

  await act(async () => {
    await view.result.current.kick('p2')
  })

  expect(view.confirm).toHaveBeenCalledTimes(1)
  expect(view.game.kick).not.toHaveBeenCalled()
})

test('answers queued mid-test are used in order and ask maps booleans to its strings', async () => {
  const { view } = renderHostActions()
  view.queueAnswers('dismiss', true, false)

  await expect(view.ask({ title: 'First' })).resolves.toBe('dismiss')
  await expect(view.ask({ title: 'Second' })).resolves.toBe('confirm')
  await expect(view.confirm({ title: 'Third' })).resolves.toBe(false)
})

test('a prompt with an empty answer queue fails loudly', async () => {
  const { view } = renderHostActions()

  await expect(view.confirm({ title: 'Kick Player?' })).rejects.toThrow('answer queue is empty')
})

// --- Router and providers --------------------------------------------------------

test('starts at the given URL and navigate moves the router', () => {
  const view = renderGameHook((fixture) => fixture, { url: '/room/ABC234' })

  expect(view.location().pathname).toBe('/room/ABC234')
  expect(window.location.pathname).toBe('/room/ABC234')

  act(() => {
    view.result.current.navigate('/Home')
  })

  expect(view.navigate).toHaveBeenCalledWith('/Home')
  expect(view.location().pathname).toBe('/Home')
})

test('a route option renders the hook only when the URL matches it', () => {
  const view = renderGameHook(() => 'rendered', { url: '/Home', route: '/room/:code' })

  expect(view.result.current).toBeNull()
})

test('the auth provider signs in as the configured user', async () => {
  const view = renderGameHook(() => useAuth())

  await waitFor(() => {
    expect(view.result.current.user).toEqual(DEFAULT_USER)
  })
})

test('useGameRoom renders inside the fixture and loads the room by its URL code', async () => {
  const room = makeRoom({ status: 'waiting' })
  const players = [makePlayer('p1', { is_host: true })]
  const view = renderGameHook(() => useGameRoom(), {
    url: `/room/${ROOM_CODE}`,
    game: { lookupRoom: async () => ({ room, players, my_player: null }) },
  })

  await waitFor(() => {
    expect(view.result.current.table.room).toEqual(room)
  })
  expect(view.game.lookupRoom).toHaveBeenCalledWith(ROOM_CODE)
})
