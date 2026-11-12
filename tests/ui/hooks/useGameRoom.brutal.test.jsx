// useGameRoom in Brutal: the toast for a −15 (X43), and the rows of the plan's section 3.8 for a room in
// Brutal, against a small fake server changed between refetches.
import { act, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useGameRoom } from '@/pages/gameRoom/useGameRoom'
import { useGameModeTheme } from '@/hooks/useGameModeTheme'
import { DEFAULT_USER, makePlayer, makeRoom, renderGameHook, ROOM_CODE } from '../fixtures/renderGameHook.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

const ATTACK_TOAST = 'Sam flipped 7 and took 15 points from you'

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

/** A room I (p1) am in, hosted by me or by Sam (p2). */
function createServer({ isHost = false, status = 'playing', gameMode = 'brutal', roundScores = [] } = {}) {
  const hostId = isHost ? 'p1' : 'p2'
  return {
    room: makeRoom({ status, host_player_id: hostId, host_email: `${hostId}@example.com`, game_mode: gameMode }),
    players: [
      makePlayer('p1', { is_host: isHost, email: DEFAULT_USER.email, name: 'Me' }),
      makePlayer('p2', { is_host: !isHost, turn_order: 1, name: 'Sam' }),
    ],
    roundScores,
  }
}

async function renderRoom(server) {
  const view = renderGameHook((fixture) => useGameRoom(), {
    url: `/room/${ROOM_CODE}`,
    game: {
      lookupRoom: async () => ({ room: server.room, players: server.players, my_player: server.players[0] }),
    },
  })
  view.backend.entities.GameRoom.filter.mockImplementation(async () => [server.room])
  view.backend.entities.Player.filter.mockImplementation(async () => server.players)
  view.backend.entities.RoundScore.filter.mockImplementation(async () => server.roundScores)
  await waitFor(() => expect(view.result.current.table.hasJoined).toBe(true))
  return view
}

async function refetch(view, server, changes = {}) {
  const { room, ...otherChanges } = changes
  Object.assign(server, otherChanges)
  server.room = { ...server.room, ...room, version: server.room.version + 1 }
  await act(async () => {
    view.emitRealtime('ready', { seq: 1 })
  })
  await waitFor(() => expect(view.result.current.table.room.version).toBe(server.room.version))
  await waitFor(() => expect(view.result.current.table.roundScores).toEqual(server.roundScores))
}

function attackFrom(attackerId, targetId, id = 's1') {
  return { id, player_id: attackerId, round_number: 1, final_score: 28, cards: [], flip7_attack_player_id: targetId }
}

// --- The toast ----------------------------------------------------------------------

test('a −15 on me gets a toast naming who took it', async () => {
  const server = createServer()
  const view = await renderRoom(server)

  await refetch(view, server, { roundScores: [attackFrom('p2', 'p1')] })

  expect(info).toHaveBeenCalledWith(ATTACK_TOAST)
})

test('an attack already there when the room loads says nothing', async () => {
  const server = createServer({ roundScores: [attackFrom('p2', 'p1')] })
  const view = await renderRoom(server)

  await refetch(view, server)

  expect(info).not.toHaveBeenCalledWith(ATTACK_TOAST)
})

test('an attack on someone else says nothing to me', async () => {
  const server = createServer()
  const view = await renderRoom(server)

  await refetch(view, server, { roundScores: [attackFrom('p2', 'p3')] })

  expect(info).not.toHaveBeenCalled()
})

test('the same attack seen on a later refetch toasts once', async () => {
  const server = createServer()
  const view = await renderRoom(server)
  await refetch(view, server, { roundScores: [attackFrom('p2', 'p1')] })

  await refetch(view, server, { roundScores: [{ ...attackFrom('p2', 'p1') }] })

  expect(info.mock.calls.filter(([message]) => message === ATTACK_TOAST)).toHaveLength(1)
})

test('an attack taken back and made again is told again', async () => {
  const server = createServer()
  const view = await renderRoom(server)
  await refetch(view, server, { roundScores: [attackFrom('p2', 'p1')] })

  await refetch(view, server, { roundScores: [] })
  await refetch(view, server, { roundScores: [attackFrom('p2', 'p1', 's2')] })

  expect(info.mock.calls.filter(([message]) => message === ATTACK_TOAST)).toHaveLength(2)
})

test('an attacker who has left is "Someone"', async () => {
  const server = createServer()
  const view = await renderRoom(server)

  await refetch(view, server, { roundScores: [attackFrom('gone', 'p1')] })

  expect(info).toHaveBeenCalledWith('Someone flipped 7 and took 15 points from you')
})

// --- Section 3.8, for a room in Brutal ---------------------------------------------

test('join or rejoin: the Brutal theme applies with no toast and no shift', async () => {
  const view = await renderRoom(createServer())

  expect(themeAttribute()).toBe('brutal')
  expect(view.result.current.theme.mode).toBe('brutal')
  expect(view.result.current.theme.shift).toBeNull()
  expect(info).not.toHaveBeenCalled()
})

test('kicked or left: the attribute comes off', async () => {
  const view = await renderRoom(createServer())

  view.unmount()

  expect(themeAttribute()).toBeNull()
})

test('a guest is told about a switch to Brutal, and sees the shift', async () => {
  const server = createServer({ gameMode: 'classic', status: 'waiting' })
  const view = await renderRoom(server)

  await refetch(view, server, { room: { game_mode: 'brutal' } })

  expect(info).toHaveBeenCalledWith('Host switched to Brutal')
  expect(view.result.current.theme.shift).toMatchObject({ from: 'classic', to: 'brutal' })
})

test('a guest entering cards is told they were re-scored', async () => {
  const server = createServer({ gameMode: 'vengeance' })
  const view = await renderRoom(server)
  act(() => view.result.current.scoreEntry.openScoreEntry('manual'))

  await refetch(view, server, { room: { game_mode: 'brutal' } })

  expect(info).toHaveBeenCalledWith('Host switched to Brutal. Your cards were re-scored')
})

test('play again keeps Brutal, and the host can still switch', async () => {
  const server = createServer({ isHost: true, status: 'finished' })
  const view = await renderRoom(server)

  await refetch(view, server, { room: { status: 'waiting', game_number: 2 } })

  expect(themeAttribute()).toBe('brutal')
  expect(view.result.current.theme.shift).toBeNull()
  await act(() => view.result.current.host.setGameMode('classic'))
  expect(view.game.setGameMode).toHaveBeenCalledWith(server.room.id, 'classic')
})

test('reopening keeps Brutal and plays no shift or switch toast', async () => {
  const server = createServer({ status: 'finished' })
  const view = await renderRoom(server)

  await refetch(view, server, { room: { status: 'playing' } })

  expect(themeAttribute()).toBe('brutal')
  expect(view.result.current.theme.shift).toBeNull()
  expect(info).toHaveBeenCalledWith('Host reopened the game')
  expect(info).not.toHaveBeenCalledWith(expect.stringContaining('Host switched'))
})

test('a new host in a waiting Brutal room gets the switch', async () => {
  const server = createServer({ status: 'waiting' })
  const view = await renderRoom(server)
  expect(view.result.current.table.isHost).toBe(false)

  await refetch(view, server, {
    room: { host_player_id: 'p1', host_email: DEFAULT_USER.email },
    players: [
      { ...server.players[0], is_host: true },
      { ...server.players[1], is_host: false },
    ],
  })

  await waitFor(() => expect(view.result.current.table.isHost).toBe(true))
  await act(() => view.result.current.host.setGameMode('vengeance'))
  expect(view.game.setGameMode).toHaveBeenCalledWith(server.room.id, 'vengeance')
})

// --- Brutal's mood shifts, through the hook that times them -------------------------

const BRUTAL_SHIFTS = [
  ['classic', 'brutal'],
  ['vengeance', 'brutal'],
  ['brutal', 'classic'],
  ['brutal', 'vengeance'],
]

for (const [from, to] of BRUTAL_SHIFTS) {
  test(`a shift from ${from} to ${to} swaps the theme at full cover, then ends`, () => {
    vi.useFakeTimers()
    try {
      const view = renderGameHook((_fixture, props) => useGameModeTheme(props), {
        initialProps: { roomId: 'r1', mode: from },
      })
      expect(themeAttribute()).toBe(from)

      view.rerender({ roomId: 'r1', mode: to })
      const { coverMs, fadeMs } = view.result.current.modeShift
      expect(view.result.current.modeShift).toMatchObject({ from, to })
      expect(themeAttribute()).toBe(from)

      act(() => vi.advanceTimersByTime(coverMs))
      expect(themeAttribute()).toBe(to)

      act(() => vi.advanceTimersByTime(fadeMs))
      expect(view.result.current.modeShift).toBeNull()
    } finally {
      vi.runOnlyPendingTimers()
      vi.useRealTimers()
    }
  })
}
