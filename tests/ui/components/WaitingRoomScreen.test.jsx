// WaitingRoomScreen: what the host and other players can do before the game starts.
import { fireEvent, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import WaitingRoomScreen from '@/pages/gameRoom/WaitingRoomScreen'
import { makePlayer } from '../fixtures/renderGameHook.jsx'
import { renderRoomScreen } from '../fixtures/renderRoomScreen.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

// The page scrolls inside Layout's container, not the window, so the screen scrolls itself
// into view on mount. jsdom has no layout; spy on the call instead.
let scrollIntoView
beforeEach(() => {
  scrollIntoView = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoView
})

const HOST = makePlayer('p1', { is_host: true })
const GUEST = makePlayer('p2', { turn_order: 1 })

function renderWaitingRoom({ isHost, others, busy, room }) {
  return renderRoomScreen(WaitingRoomScreen, {
    me: isHost ? HOST : GUEST,
    others: others ?? [isHost ? GUEST : HOST],
    isHost,
    busy,
    room: { status: 'waiting', ...room },
  })
}

describe('WaitingRoomScreen in Brutal', () => {
  it('Start names the mode', async () => {
    await renderWaitingRoom({ isHost: true, room: { game_mode: 'brutal' } })

    expect(screen.getByRole('button', { name: 'Start Brutal Game' })).toBeInTheDocument()
  })
})

describe('WaitingRoomScreen: host', () => {
  it('scrolls to the top when it opens', async () => {
    await renderWaitingRoom({ isHost: true })

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
  })

  it('puts Start Game in the room code card, above the icon buttons', async () => {
    await renderWaitingRoom({ isHost: true })

    const share = screen.getByRole('button', { name: 'Share join link' })
    const start = screen.getByRole('button', { name: /start game/i })
    expect(share.parentElement.parentElement).toContainElement(start)
    expect(start.compareDocumentPosition(share) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('starts the game', async () => {
    const props = await renderWaitingRoom({ isHost: true })

    fireEvent.click(screen.getByRole('button', { name: /start game/i }))

    expect(props.game.host.start).toHaveBeenCalledTimes(1)
  })

  // X63: a host alone can start, to try the app out.
  it('lets the host start alone, with a hint that it is just them', async () => {
    const props = await renderWaitingRoom({ isHost: true, others: [] })

    const start = screen.getByRole('button', { name: /start game/i })
    expect(start).toBeEnabled()
    fireEvent.click(start)
    expect(props.game.host.start).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Just you so far. Start now to try things out.')).toBeInTheDocument()
  })

  it('drops the hint once someone else has joined', async () => {
    await renderWaitingRoom({ isHost: true })

    expect(screen.queryByText(/just you so far/i)).not.toBeInTheDocument()
  })

  it('kicks, makes host and sets the first player', async () => {
    const props = await renderWaitingRoom({ isHost: true })

    fireEvent.click(screen.getByRole('button', { name: 'Kick p2' }))
    fireEvent.click(screen.getByRole('button', { name: /make host/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Make p2 go first' }))

    expect(props.game.host.kick).toHaveBeenCalledWith('p2')
    expect(props.game.host.makeHost).toHaveBeenCalledWith('p2')
    expect(props.game.host.setFirstPlayer).toHaveBeenCalledWith('p2')
  })

  it('offers Edit Games Won once, whichever dialog is mounted above it', async () => {
    await renderWaitingRoom({ isHost: true })

    expect(screen.getAllByRole('button', { name: /edit games won/i })).toHaveLength(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('can edit games won and close the room, and has no Leave button', async () => {
    const props = await renderWaitingRoom({ isHost: true })

    fireEvent.click(screen.getByRole('button', { name: /edit games won/i }))
    fireEvent.click(screen.getByRole('button', { name: /close room/i }))

    expect(props.game.dialogs.openGamesWon).toHaveBeenCalledTimes(1)
    expect(props.game.host.closeRoom).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /leave room/i })).not.toBeInTheDocument()
  })
})

describe('WaitingRoomScreen: the game mode (X41)', () => {
  it('names the mode on Start, the last chance to catch a wrong choice cheaply', async () => {
    await renderWaitingRoom({ isHost: true, room: { game_mode: 'vengeance' } })

    expect(screen.getByRole('button', { name: 'Start Vengeance Game' })).toBeInTheDocument()
  })

  it('Classic stays Start Game', async () => {
    await renderWaitingRoom({ isHost: true })

    expect(screen.getByRole('button', { name: 'Start Game' })).toBeInTheDocument()
  })

  it('the host can open the picker from the logo', async () => {
    await renderWaitingRoom({ isHost: true })

    expect(screen.getByRole('button', { name: /Game mode: Classic. Change/ })).toBeInTheDocument()
  })

  it('a guest sees the mode name and the Rules button', async () => {
    await renderWaitingRoom({ isHost: false })

    expect(screen.queryByRole('button', { name: /Change mode/ })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Game mode: Classic')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rules' })).toBeInTheDocument()
  })
})

describe('WaitingRoomScreen: other players', () => {
  it('have no host controls', async () => {
    await renderWaitingRoom({ isHost: false })

    expect(screen.queryByRole('button', { name: /start game/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /kick/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /make host/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /go first/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /close room/i })).not.toBeInTheDocument()
  })

  it('can leave', async () => {
    const props = await renderWaitingRoom({ isHost: false })

    fireEvent.click(screen.getByRole('button', { name: /leave room/i }))

    expect(props.game.leave).toHaveBeenCalledTimes(1)
  })

  it('shows Leaving, disabled, while the leave is running', async () => {
    await renderWaitingRoom({ isHost: false, busy: { leave: true } })

    expect(screen.getByRole('button', { name: /leaving/i })).toBeDisabled()
  })
})
