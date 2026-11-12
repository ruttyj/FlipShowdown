// useGameRoom: joining a room, by hand and automatically (decisions X3,
// X6 and B5). The room lives in a small fake server so a test can
// kick me, close the room or reload the page between renders.
import { act, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useGameRoom } from '@/pages/gameRoom/useGameRoom'
import { DEFAULT_USER, makePlayer, makeRoom, renderGameHook, ROOM_CODE, ROOM_ID } from '../fixtures/renderGameHook.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

// Joining a waiting room plays a chime on timers that would outlive the test; muted, the
// chime returns at once (setup.js clears localStorage after each test).
beforeEach(() => {
  localStorage.setItem('flip7_sound_muted', 'true')
})

afterEach(() => {
  vi.restoreAllMocks()
})

// --- Fake server -----------------------------------------------------------------
// One room per code. `memberIds` holds the Player ids the server says are mine (p1 is me:
// makePlayer('p1') has DEFAULT_USER's email).

const MY_PLAYER_ID = 'p1'
const OTHER_CODE = 'XYZ789'

function makeServerRoom({ status = 'waiting', isMember = false, id = ROOM_ID, code = ROOM_CODE } = {}) {
  const room = makeRoom({ id, code, status, host_player_id: 'p2', host_email: 'p2@example.com' })
  const players = [makePlayer('p2', { room_id: id, is_host: true })]
  if (isMember) {
    players.push(makePlayer(MY_PLAYER_ID, { room_id: id, turn_order: 1 }))
  }
  return { room, players }
}

function createServer(rooms) {
  const server = { rooms: {} }
  for (const serverRoom of rooms) {
    server.rooms[serverRoom.room.code] = serverRoom
  }
  return server
}

function findMyPlayer(serverRoom) {
  return serverRoom.players.find((player) => player.id === MY_PLAYER_ID) ?? null
}

function findRoomById(server, roomId) {
  return Object.values(server.rooms).find((serverRoom) => serverRoom.room.id === roomId)
}

function lookup(server, code) {
  const serverRoom = server.rooms[code]
  if (!serverRoom) {
    const error = new Error('Room not found')
    error.status = 404
    throw error
  }
  return { room: serverRoom.room, players: serverRoom.players, my_player: findMyPlayer(serverRoom) }
}

function addMe(server, roomId, name) {
  const serverRoom = findRoomById(server, roomId)
  const turnOrder = serverRoom.players.length
  serverRoom.players.push(makePlayer(MY_PLAYER_ID, { room_id: roomId, name, turn_order: turnOrder }))
}

function removeMe(server, code = ROOM_CODE) {
  const serverRoom = server.rooms[code]
  serverRoom.players = serverRoom.players.filter((player) => player.id !== MY_PLAYER_ID)
}

/** The member reads (entities) return only rooms I'm in, like the server. */
function installMemberReads(entities, server) {
  const readMine = (roomId) => {
    const serverRoom = findRoomById(server, roomId)
    if (!serverRoom || !findMyPlayer(serverRoom)) {
      return null
    }
    return serverRoom
  }

  entities.GameRoom.filter.mockImplementation(async ({ id }) => {
    const serverRoom = readMine(id)
    return serverRoom ? [serverRoom.room] : []
  })
  entities.Player.filter.mockImplementation(async ({ room_id: roomId }) => {
    const serverRoom = readMine(roomId)
    return serverRoom ? serverRoom.players : []
  })
}

// --- Rendering -------------------------------------------------------------------

/**
 * Renders useGameRoom at /room/<code> against the fake server. `game` overrides
 * replace the server's own join and leave; `onRender` sees every render's result.
 */
function renderRoom(server, { code = ROOM_CODE, game = {}, user, onRender } = {}) {
  const serverGame = {
    lookupRoom: async (lookupCode) => lookup(server, lookupCode),
    join: async (roomId, { name }) => {
      addMe(server, roomId, name)
      return { ok: true }
    },
    leave: async (roomId) => {
      removeMe(server, findRoomById(server, roomId).room.code)
      return { ok: true }
    },
    ...game,
  }

  const options = { url: `/room/${code}`, game: serverGame }
  if (user !== undefined) {
    options.user = user
  }
  const view = renderGameHook(() => {
    const gameRoom = useGameRoom()
    if (onRender) {
      onRender(gameRoom)
    }
    return gameRoom
  }, options)
  // Installed before any await, so the first fetch (which awaits the lookup first) sees them.
  installMemberReads(view.backend.entities, server)
  return view
}

/** Waits until the room has loaded, I'm signed in and auto-join has had its go. */
async function waitForSettled(view) {
  await waitFor(() => {
    const current = view.result.current
    expect(current.load.status).toBe('ready')
    expect(current.load.isSigningIn).toBe(false)
    expect(current.joining.isAutoJoining).toBe(false)
  })
  // Let any effect queued by the last render run before the test asserts.
  await act(async () => {})
}

async function refetchRoom(view) {
  await act(() => view.result.current.load.retry())
}

function spyOnErrorToast() {
  return vi.spyOn(toast, 'error').mockImplementation(() => {})
}

// --- Auto-join -------------------------------------------------------------------

test('signed in and not a member: joins once under my account name', async () => {
  const server = createServer([makeServerRoom()])
  const view = renderRoom(server)

  await waitForSettled(view)

  expect(view.game.join).toHaveBeenCalledTimes(1)
  expect(view.game.join).toHaveBeenCalledWith(ROOM_ID, { name: DEFAULT_USER.full_name })
  expect(view.result.current.table.hasJoined).toBe(true)
})

test('already a member: no join call', async () => {
  const server = createServer([makeServerRoom({ isMember: true })])
  const view = renderRoom(server)

  await waitForSettled(view)

  expect(view.result.current.table.hasJoined).toBe(true)
  expect(view.game.join).not.toHaveBeenCalled()
})

test('kicked while in the room: no auto-join, the Join screen is shown', async () => {
  spyOnErrorToast()
  const server = createServer([makeServerRoom({ isMember: true })])
  const view = renderRoom(server)
  await waitForSettled(view)

  removeMe(server)
  await refetchRoom(view)
  await waitForSettled(view)

  expect(view.result.current.table.hasJoined).toBe(false)
  expect(view.result.current.joining.isAutoJoining).toBe(false)
  expect(view.game.join).not.toHaveBeenCalled()
})

test('kicked, then the page is reloaded: no auto-join (X3)', async () => {
  spyOnErrorToast()
  const server = createServer([makeServerRoom({ isMember: true })])
  const firstVisit = renderRoom(server)
  await waitForSettled(firstVisit)
  removeMe(server)
  await refetchRoom(firstVisit)
  await waitFor(() => {
    expect(firstVisit.result.current.table.hasJoined).toBe(false)
  })
  firstVisit.unmount()

  const reload = renderRoom(server)
  await waitForSettled(reload)

  expect(reload.game.join).not.toHaveBeenCalled()
  expect(reload.result.current.table.hasJoined).toBe(false)
})

test('left on purpose, then back to the room page: no auto-join (X3)', async () => {
  const server = createServer([makeServerRoom({ isMember: true })])
  const firstVisit = renderRoom(server)
  await waitForSettled(firstVisit)
  // leave asks through the hook's own ConfirmDialog, which the screen would show.
  let leaving
  act(() => {
    leaving = firstVisit.result.current.leave()
  })
  await waitFor(() => {
    expect(firstVisit.result.current.dialogs.confirmation.open).toBe(true)
  })
  await act(async () => {
    firstVisit.result.current.dialogs.confirmation.onConfirm()
    await leaving
  })
  expect(firstVisit.game.leave).toHaveBeenCalledWith(ROOM_ID)
  firstVisit.unmount()

  const back = renderRoom(server)
  await waitForSettled(back)

  expect(back.game.join).not.toHaveBeenCalled()
  expect(back.result.current.table.hasJoined).toBe(false)
})

test('a manual Join after being kicked clears the flag, so a later visit auto-joins again (X3)', async () => {
  spyOnErrorToast()
  const server = createServer([makeServerRoom({ isMember: true })])
  const firstVisit = renderRoom(server)
  await waitForSettled(firstVisit)
  removeMe(server)
  await refetchRoom(firstVisit)
  await waitFor(() => {
    expect(firstVisit.result.current.table.hasJoined).toBe(false)
  })

  await act(() => firstVisit.result.current.joining.join('Player One'))
  await waitFor(() => {
    expect(firstVisit.result.current.table.hasJoined).toBe(true)
  })
  firstVisit.unmount()

  // Removed again while the page was closed (e.g. the server lost me): nothing remembers a
  // kick or a leave any more, so auto-join runs.
  removeMe(server)
  const later = renderRoom(server)
  await waitForSettled(later)

  expect(later.game.join).toHaveBeenCalledTimes(1)
  expect(later.result.current.table.hasJoined).toBe(true)
})

test('the kick flag belongs to one room code: another room still auto-joins (X3)', async () => {
  spyOnErrorToast()
  const server = createServer([
    makeServerRoom({ isMember: true }),
    makeServerRoom({ id: 'room-2', code: OTHER_CODE }),
  ])
  const firstVisit = renderRoom(server)
  await waitForSettled(firstVisit)
  removeMe(server)
  await refetchRoom(firstVisit)
  await waitFor(() => {
    expect(firstVisit.result.current.table.hasJoined).toBe(false)
  })
  firstVisit.unmount()

  const otherRoom = renderRoom(server, { code: OTHER_CODE })
  await waitForSettled(otherRoom)

  expect(otherRoom.game.join).toHaveBeenCalledWith('room-2', { name: DEFAULT_USER.full_name })
})

test('kicked from a room whose code is later reused: the new room still auto-joins (X3b)', async () => {
  spyOnErrorToast()
  const server = createServer([makeServerRoom({ isMember: true })])
  const firstVisit = renderRoom(server)
  await waitForSettled(firstVisit)
  removeMe(server)
  await refetchRoom(firstVisit)
  await waitFor(() => {
    expect(firstVisit.result.current.table.hasJoined).toBe(false)
  })
  firstVisit.unmount()

  // The old room closed and a new room was given the same code.
  const reused = createServer([makeServerRoom({ id: 'room-new' })])
  const newRoom = renderRoom(reused)
  await waitForSettled(newRoom)

  expect(newRoom.game.join).toHaveBeenCalledWith('room-new', { name: DEFAULT_USER.full_name })
})

test('a closed room: no join call, no error toast, and the room-closed state shows (X6)', async () => {
  const errorToast = spyOnErrorToast()
  const closedRoom = makeServerRoom()
  closedRoom.room.status = 'closed'
  const server = createServer([closedRoom])
  const view = renderRoom(server)

  await waitForSettled(view)

  expect(view.result.current.load.isRoomGone).toBe(true)
  expect(view.result.current.joining.isAutoJoining).toBe(false)
  expect(view.game.join).not.toHaveBeenCalled()
  expect(errorToast).not.toHaveBeenCalled()
})

test.each(['playing', 'finished'])('a %s room is auto-joined like a waiting one (mid-game join, B5)', async (status) => {
  const server = createServer([makeServerRoom({ status })])
  const view = renderRoom(server)

  await waitForSettled(view)

  expect(view.game.join).toHaveBeenCalledTimes(1)
  expect(view.game.join).toHaveBeenCalledWith(ROOM_ID, { name: DEFAULT_USER.full_name })
  expect(view.result.current.table.hasJoined).toBe(true)
})

test('a failed auto-join shows the Join screen once, with my name filled in and one error toast', async () => {
  const errorToast = spyOnErrorToast()
  const server = createServer([makeServerRoom()])
  const failure = Object.assign(new Error('Server busy'), { status: 500 })
  const view = renderRoom(server, { game: { join: () => Promise.reject(failure) } })

  await waitForSettled(view)
  view.rerender()
  await refetchRoom(view)
  await waitForSettled(view)

  expect(view.game.join).toHaveBeenCalledTimes(1)
  expect(errorToast).toHaveBeenCalledTimes(1)
  expect(view.result.current.table.hasJoined).toBe(false)
  expect(view.result.current.joining.isJoining).toBe(false)
  expect(view.result.current.joining.name).toBe(DEFAULT_USER.full_name)
})

test('the join succeeds but the refetch never shows me: the spinner gives way to the Join screen', async () => {
  const server = createServer([makeServerRoom()])
  // The server answers ok but the lookups keep missing me (e.g. a lagging replica).
  const view = renderRoom(server, { game: { join: async () => ({ ok: true }) } })

  await waitForSettled(view)

  expect(view.game.join).toHaveBeenCalledTimes(1)
  expect(view.result.current.table.hasJoined).toBe(false)
  expect(view.result.current.joining.isJoining).toBe(false)
})

test('the join succeeds but the refetch never shows me: the next refetch that does recovers', async () => {
  const server = createServer([makeServerRoom()])
  const view = renderRoom(server, { game: { join: async () => ({ ok: true }) } })
  await waitForSettled(view)

  addMe(server, ROOM_ID, DEFAULT_USER.full_name)
  await refetchRoom(view)

  await waitFor(() => {
    expect(view.result.current.table.hasJoined).toBe(true)
  })
  expect(view.game.join).toHaveBeenCalledTimes(1)
})

test('a full_name of only spaces falls back to the email name', async () => {
  const server = createServer([makeServerRoom()])
  const user = { ...DEFAULT_USER, full_name: '   ' }
  const view = renderRoom(server, { user })

  await waitForSettled(view)

  expect(view.game.join).toHaveBeenCalledWith(ROOM_ID, { name: 'p1' })
})

test('a name over 100 characters is sent as it is (the server truncates it)', async () => {
  const server = createServer([makeServerRoom()])
  const longName = 'N'.repeat(120)
  const view = renderRoom(server, { user: { ...DEFAULT_USER, full_name: longName } })

  await waitForSettled(view)

  expect(view.game.join).toHaveBeenCalledWith(ROOM_ID, { name: longName })
})

test('auto-join is tried once per room, across re-renders and refetches', async () => {
  spyOnErrorToast()
  const server = createServer([makeServerRoom()])
  const view = renderRoom(server, { game: { join: () => Promise.reject(new Error('nope')) } })
  await waitForSettled(view)

  view.rerender()
  view.rerender()
  await refetchRoom(view)
  await waitForSettled(view)

  expect(view.game.join).toHaveBeenCalledTimes(1)
})

test('moving to a different room code tries again for the new room', async () => {
  const server = createServer([
    makeServerRoom(),
    makeServerRoom({ id: 'room-2', code: OTHER_CODE }),
  ])
  const view = renderRoom(server)
  await waitForSettled(view)

  window.history.replaceState(null, '', `/room/${OTHER_CODE}`)
  view.rerender()
  await waitFor(() => {
    expect(view.result.current.table.room?.id).toBe('room-2')
  })
  await waitForSettled(view)

  expect(view.game.join).toHaveBeenCalledTimes(2)
  expect(view.game.join).toHaveBeenLastCalledWith('room-2', { name: DEFAULT_USER.full_name })
})

test('the Join screen never flashes before the automatic join has run', async () => {
  const server = createServer([makeServerRoom()])
  let finishJoin
  const joinScreenRenders = []
  const recordRender = (current) => {
    const showsJoinScreen = current.user !== null
      && current.load.status === 'ready'
      && !current.table.hasJoined
      && !current.joining.isAutoJoining
    if (showsJoinScreen) {
      joinScreenRenders.push(current)
    }
  }
  const view = renderRoom(server, {
    onRender: recordRender,
    game: {
      join: (roomId, { name }) => new Promise((resolve) => {
        finishJoin = () => {
          addMe(server, roomId, name)
          resolve({ ok: true })
        }
      }),
    },
  })

  await waitFor(() => {
    expect(view.game.join).toHaveBeenCalled()
  })
  await act(async () => {
    finishJoin()
  })
  await waitFor(() => {
    expect(view.result.current.table.hasJoined).toBe(true)
  })

  expect(joinScreenRenders).toEqual([])
})

// --- Manual join -----------------------------------------------------------------

test('a manual join trims the name and rejects an empty one', async () => {
  spyOnErrorToast()
  const server = createServer([makeServerRoom({ isMember: true })])
  const view = renderRoom(server)
  await waitForSettled(view)
  removeMe(server)
  await refetchRoom(view)
  await waitFor(() => {
    expect(view.result.current.table.hasJoined).toBe(false)
  })

  await act(() => view.result.current.joining.join('   '))
  expect(view.game.join).not.toHaveBeenCalled()

  await act(() => view.result.current.joining.join('  Pat  '))
  expect(view.game.join).toHaveBeenCalledWith(ROOM_ID, { name: 'Pat' })
})
