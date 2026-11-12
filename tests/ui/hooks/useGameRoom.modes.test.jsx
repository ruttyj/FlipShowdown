// useGameRoom and the room's mode (X41): the theme, the words that go with a switch, and
// the mode reaching the score entry. The room lives in a small fake server changed between refetches.
import { act, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useGameRoom } from '@/pages/gameRoom/useGameRoom'
import { DEFAULT_USER, makePlayer, makeRoom, renderGameHook, ROOM_CODE } from '../fixtures/renderGameHook.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

let info

beforeEach(() => {
  localStorage.setItem('flip7_sound_muted', 'true')
  info = vi.spyOn(toast, 'info').mockImplementation(() => 'toast-id')
})

afterEach(() => {
  vi.restoreAllMocks()
})

function themeAttribute() {
  return document.documentElement.getAttribute('data-game-mode')
}

/** A room I am in, hosted by me (p1) or by p2. */
function createServer({ isHost = false, status = 'waiting', gameMode } = {}) {
  const hostId = isHost ? 'p1' : 'p2'
  const room = makeRoom({
    status,
    host_player_id: hostId,
    host_email: `${hostId}@example.com`,
    game_mode: gameMode,
  })
  const players = [
    makePlayer('p1', { is_host: isHost, email: DEFAULT_USER.email }),
    makePlayer('p2', { is_host: !isHost, turn_order: 1 }),
  ]
  return { room, players }
}

async function renderRoom(server) {
  const view = renderGameHook((fixture) => useGameRoom(fixture), {
    url: `/room/${ROOM_CODE}`,
    game: {
      lookupRoom: async () => ({ room: server.room, players: server.players, my_player: server.players[0] }),
    },
  })
  view.backend.entities.GameRoom.filter.mockImplementation(async () => [server.room])
  view.backend.entities.Player.filter.mockImplementation(async () => server.players)
  await waitFor(() => expect(view.result.current.table.hasJoined).toBe(true))
  return view
}

/** The server changes the mode, and the client hears about it on the next refetch. */
async function switchMode(view, server, gameMode) {
  server.room = { ...server.room, game_mode: gameMode, version: server.room.version + 1 }
  await act(async () => {
    view.emitRealtime('ready', { seq: 1 })
  })
  await waitFor(() => expect(view.result.current.table.room.game_mode).toBe(gameMode))
}

/** The server changes the status, and the client hears about it on the next refetch. */
async function changeStatus(view, server, status) {
  server.room = { ...server.room, status, version: server.room.version + 1 }
  await act(async () => {
    view.emitRealtime('ready', { seq: 1 })
  })
  await waitFor(() => expect(view.result.current.table.room.status).toBe(status))
}

test('a guest is told when the host reopens the game (X45)', async () => {
  const server = createServer({ isHost: false, status: 'finished' })
  const view = await renderRoom(server)

  await changeStatus(view, server, 'playing')

  expect(info).toHaveBeenCalledWith('Host reopened the game')
})

test('the host who reopened it is not told (X45)', async () => {
  const server = createServer({ isHost: true, status: 'finished' })
  const view = await renderRoom(server)

  await changeStatus(view, server, 'playing')

  expect(info).not.toHaveBeenCalledWith('Host reopened the game')
})

test('a game starting is not called reopened (X45)', async () => {
  const server = createServer({ isHost: false, status: 'waiting' })
  const view = await renderRoom(server)

  await changeStatus(view, server, 'playing')

  expect(info).not.toHaveBeenCalledWith('Host reopened the game')
})

test('reopening keeps the mode and plays no shift (X45)', async () => {
  const server = createServer({ isHost: false, status: 'finished', gameMode: 'vengeance' })
  const view = await renderRoom(server)

  await changeStatus(view, server, 'playing')

  expect(themeAttribute()).toBe('vengeance')
  expect(view.result.current.theme.shift).toBeNull()
})

test('the theme follows the room with no toast and no shift on first load', async () => {
  const view = await renderRoom(createServer({ gameMode: 'vengeance' }))

  expect(themeAttribute()).toBe('vengeance')
  expect(view.result.current.theme.mode).toBe('vengeance')
  expect(view.result.current.theme.shift).toBeNull()
  expect(info).not.toHaveBeenCalled()
})

test('an old room with no mode reads as classic', async () => {
  const view = await renderRoom(createServer())

  expect(view.result.current.theme.mode).toBe('classic')
  expect(themeAttribute()).toBe('classic')
})

test('leaving the room removes the theme', async () => {
  const view = await renderRoom(createServer({ gameMode: 'vengeance' }))

  view.unmount()

  expect(themeAttribute()).toBeNull()
})

test('a guest is told the new mode, and sees a shift', async () => {
  const server = createServer()
  const view = await renderRoom(server)

  await switchMode(view, server, 'vengeance')

  expect(info).toHaveBeenCalledWith('Host switched to Vengeance')
  expect(view.result.current.theme.shift).toMatchObject({ to: 'vengeance' })
})

test('switching an old room with no mode still counts as a change', async () => {
  const server = createServer()
  const view = await renderRoom(server)

  await switchMode(view, server, 'vengeance')

  expect(info).toHaveBeenCalledTimes(1)
})

test('a guest entering cards is also told they were re-scored', async () => {
  const server = createServer({ status: 'playing' })
  const view = await renderRoom(server)
  act(() => view.result.current.scoreEntry.openScoreEntry('manual'))

  await switchMode(view, server, 'vengeance')

  expect(info).toHaveBeenCalledWith('Host switched to Vengeance. Your cards were re-scored')
})

test('the host sees the shift but no toast, as they made the change', async () => {
  const server = createServer({ isHost: true })
  const view = await renderRoom(server)

  await switchMode(view, server, 'vengeance')

  expect(info).not.toHaveBeenCalled()
  expect(view.result.current.theme.shift).toMatchObject({ to: 'vengeance' })
})

test('a refetch with the same mode says nothing', async () => {
  const server = createServer({ gameMode: 'vengeance' })
  const view = await renderRoom(server)

  server.room = { ...server.room, version: server.room.version + 1 }
  await act(async () => {
    view.emitRealtime('ready', { seq: 1 })
  })

  await waitFor(() => expect(view.result.current.table.room.version).toBe(server.room.version))
  expect(info).not.toHaveBeenCalled()
  expect(view.result.current.theme.shift).toBeNull()
})

test('setGameMode reaches the API through the host actions', async () => {
  const server = createServer({ isHost: true })
  const view = await renderRoom(server)

  await act(() => view.result.current.host.setGameMode('vengeance'))

  expect(view.game.setGameMode).toHaveBeenCalledWith(server.room.id, 'vengeance')
})
