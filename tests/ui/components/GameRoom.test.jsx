// GameRoom page: which screen each room state renders (not found, loading, closed, kicked,
// waiting, ...), against a small fake server. Decisions X6 (a closed room shows the
// room-closed screen, never the auto-join spinner) and X3 (a kicked player gets the Join screen).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatMuteProvider } from '@/hooks/useRoomChat'
import { SoundProvider } from '@/components/useSound'
import { AuthProvider } from '@/lib/AuthContext'
import GameRoom from '@/pages/GameRoom'
import { DEFAULT_USER, makePlayer, makeRoom, ROOM_CODE, ROOM_ID } from '../fixtures/renderGameHook.jsx'
import { fakeBackend, fakeGame, resetFakeApi } from '../fixtures/fakeApi.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

const ME = 'p1'

beforeEach(() => {
  // Chimes run on timers that would outlive the test.
  localStorage.setItem('flip7_sound_muted', 'true')
})

afterEach(() => {
  vi.restoreAllMocks()
})

// --- Fake server -----------------------------------------------------------------

function makeServer({ status = 'waiting', isMember = false } = {}) {
  const room = makeRoom({ status, host_player_id: 'p2', host_email: 'p2@example.com' })
  const players = [makePlayer('p2', { is_host: true })]
  if (isMember) {
    players.push(makePlayer(ME, { turn_order: 1 }))
  }
  return { room, players }
}

function findMe(server) {
  return server.players.find((player) => player.id === ME) ?? null
}

function installServer(server) {
  fakeGame.lookupRoom.mockImplementation(async () => ({
    room: server.room,
    players: server.players,
    my_player: findMe(server),
  }))
  fakeGame.join.mockImplementation(async () => {
    server.players.push(makePlayer(ME, { turn_order: 1 }))
    return { ok: true }
  })
  fakeBackend.entities.GameRoom.filter.mockImplementation(async () => (findMe(server) ? [server.room] : []))
  fakeBackend.entities.Player.filter.mockImplementation(async () => (findMe(server) ? server.players : []))
}

// --- Rendering -------------------------------------------------------------------

/** `server` is a fake room; `lookup` replaces the by-code lookup (e.g. a pending or failing one). */
function renderGameRoom(server, { user = DEFAULT_USER, lookup } = {}) {
  resetFakeApi({ game: {}, user })
  installServer(server)
  if (lookup) {
    fakeGame.lookupRoom.mockImplementation(lookup)
  }
  window.history.replaceState(null, '', `/room/${ROOM_CODE}`)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/room/${ROOM_CODE}`]}>
          <SoundProvider>
            <ChatMuteProvider>
              <GameRoom />
            </ChatMuteProvider>
          </SoundProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </AuthProvider>,
  )
}

function isSpinnerShown() {
  return document.querySelector('.animate-spin') !== null
}

describe('GameRoom: states without a joined player', () => {
  it('shows a spinner while the room is loading', async () => {
    renderGameRoom(makeServer(), { lookup: () => new Promise(() => {}) })

    await act(async () => {})

    expect(isSpinnerShown()).toBe(true)
    expect(screen.queryByText('Room not found')).not.toBeInTheDocument()
    expect(screen.queryByText('Join Game')).not.toBeInTheDocument()
  })

  it('shows "Room not found" when the code does not exist', async () => {
    const notFound = Object.assign(new Error('Room not found'), { status: 404 })
    renderGameRoom(makeServer(), { lookup: () => Promise.reject(notFound) })

    expect(await screen.findByText('Room not found')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /back to home/i })).toBeInTheDocument()
    expect(fakeGame.join).not.toHaveBeenCalled()
  })

  it('a closed room shows the room-closed screen, not the auto-join spinner (X6)', async () => {
    const server = makeServer({ status: 'closed' })
    renderGameRoom(server)

    expect(await screen.findByText('This room was closed')).toBeInTheDocument()
    expect(isSpinnerShown()).toBe(false)
    expect(fakeGame.join).not.toHaveBeenCalled()
  })

  it('a non-member of an open room is joined automatically and sees the waiting room', async () => {
    const server = makeServer({ status: 'waiting' })
    renderGameRoom(server)

    expect(await screen.findByRole('button', { name: /leave room/i })).toBeInTheDocument()
    expect(fakeGame.join).toHaveBeenCalledTimes(1)
  })
})

describe('GameRoom: a member of the room', () => {
  it('renders the waiting room for a waiting room', async () => {
    renderGameRoom(makeServer({ status: 'waiting', isMember: true }))

    expect(await screen.findByRole('button', { name: /leave room/i })).toBeInTheDocument()
    expect(fakeGame.join).not.toHaveBeenCalled()
  })

  it('renders the active game for a playing room', async () => {
    renderGameRoom(makeServer({ status: 'playing', isMember: true }))

    expect(await screen.findByText('Current Turn')).toBeInTheDocument()
  })

  it('renders the finished screen for a finished room', async () => {
    renderGameRoom(makeServer({ status: 'finished', isMember: true }))

    expect(await screen.findByRole('heading', { name: 'Game Over!' })).toBeInTheDocument()
  })

  it('when I am kicked: a notice shows and the Join screen replaces the room, with no re-join (X3)', async () => {
    const errorToast = vi.spyOn(toast, 'error').mockImplementation(() => {})
    const server = makeServer({ status: 'waiting', isMember: true })
    renderGameRoom(server)
    await screen.findByRole('button', { name: /leave room/i })

    // The server removes me; the room's realtime/refetch path then notices.
    server.players = server.players.filter((player) => player.id !== ME)
    const playerSubscription = fakeBackend.entities.Player.subscribe.mock.calls[0]
    expect(playerSubscription).toBeDefined()
    act(() => {
      playerSubscription[0]({ type: 'delete', id: ME, data: makePlayer(ME), room_id: ROOM_ID }, { room_version: null, seq: 1 })
    })

    expect(await screen.findByText('Join Game')).toBeInTheDocument()
    await waitFor(() => expect(errorToast).toHaveBeenCalledWith('You were removed from the game'))
    expect(fakeGame.join).not.toHaveBeenCalled()
  })
})

describe('GameRoom: the dialogs every screen shares', () => {
  async function renderAsHost(status) {
    const server = makeServer({ status, isMember: true })
    server.room.host_player_id = ME
    server.players = server.players.map((player) => ({ ...player, is_host: player.id === ME }))
    renderGameRoom(server)
    return server
  }

  it('one confirm dialog answers a host action on the waiting screen', async () => {
    await renderAsHost('waiting')

    fireEvent.click(await screen.findByRole('button', { name: /close room/i }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Close Room?')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close Room' }))

    await waitFor(() => expect(fakeGame.closeRoom).toHaveBeenCalledWith(ROOM_ID))
  })

  it('the Games Won editor opens from the finished screen, saves and closes', async () => {
    await renderAsHost('finished')

    fireEvent.click(await screen.findByRole('button', { name: /edit games won/i }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /save/i }))
    await waitFor(() => expect(fakeGame.setGamesWon).toHaveBeenCalled())
  })

  it('a dialog left open stays open when the room moves to another screen', async () => {
    const server = await renderAsHost('waiting')
    fireEvent.click(await screen.findByRole('button', { name: /close room/i }))
    const dialog = await screen.findByRole('alertdialog')

    server.room = { ...server.room, status: 'playing', version: server.room.version + 1 }
    const roomSubscription = fakeBackend.entities.GameRoom.subscribe.mock.calls[0]
    act(() => {
      roomSubscription[0]({ type: 'update', id: ROOM_ID, data: server.room, room_id: ROOM_ID }, { room_version: server.room.version, seq: 1 })
    })

    expect(await screen.findByText('Current Turn', { hidden: true })).toBeInTheDocument()
    expect(screen.getByRole('alertdialog')).toBe(dialog)
  })

  it('a prompt still open when I am kicked is not shown on the Join screen', async () => {
    vi.spyOn(toast, 'error').mockImplementation(() => {})
    const server = makeServer({ status: 'waiting', isMember: true })
    renderGameRoom(server)
    fireEvent.click(await screen.findByRole('button', { name: /leave room/i }))
    await screen.findByRole('alertdialog')

    server.players = server.players.filter((player) => player.id !== ME)
    const playerSubscription = fakeBackend.entities.Player.subscribe.mock.calls[0]
    act(() => {
      playerSubscription[0]({ type: 'delete', id: ME, data: makePlayer(ME), room_id: ROOM_ID }, { room_version: server.room.version + 1, seq: 1 })
    })

    expect(await screen.findByText('Join Game')).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })
})

describe('GameRoom: the room mode (X41)', () => {
  it('uses the themed background and keeps the screen neutral until the room has loaded', async () => {
    renderGameRoom(makeServer(), { lookup: () => new Promise(() => {}) })

    await act(async () => {})

    expect(document.documentElement.hasAttribute('data-game-mode')).toBe(false)
    expect(document.querySelector('.game-screen-bg')).not.toBeNull()
  })

  it('applies the room mode to the page, and the Join screen shows it', async () => {
    const server = makeServer()
    server.room.game_mode = 'vengeance'
    renderGameRoom(server, { user: { ...DEFAULT_USER, email: 'new@example.com' } })

    await waitFor(() => expect(document.documentElement.getAttribute('data-game-mode')).toBe('vengeance'))
  })
})
