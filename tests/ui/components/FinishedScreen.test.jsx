// FinishedScreen: winner, the waiting message for guests, host's Play Again, and the no-winner case.
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import FinishedScreen from '@/pages/gameRoom/FinishedScreen'
import { makePlayer } from '../fixtures/renderGameHook.jsx'
import { renderRoomScreen } from '../fixtures/renderRoomScreen.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

const HOST = makePlayer('p1', { name: 'Hana', total_score: 210 })
const GUEST = makePlayer('p2', { name: 'Gus', turn_order: 1, total_score: 120 })

function renderFinished({ isHost = false, others, room = {}, busy, theme } = {}) {
  const me = isHost ? HOST : GUEST
  const options = {
    me,
    others: others ?? [isHost ? GUEST : HOST],
    isHost,
    busy,
    room: { status: 'finished', winner_player_id: 'p1', finish_reason: 'score', ...room },
  }
  if (theme) {
    options.theme = theme
  }
  return renderRoomScreen(FinishedScreen, options)
}

describe('FinishedScreen', () => {
  it('shows the winner', async () => {
    await renderFinished()

    expect(screen.getByRole('heading', { name: 'Game Over!' })).toBeInTheDocument()
    expect(screen.getByText(/wins!/)).toHaveTextContent('Hana wins!')
  })

  it('shows a canceled game when the host ended it', async () => {
    await renderFinished({ room: { finish_reason: 'ended' } })

    expect(screen.getByRole('heading', { name: 'Game Canceled!' })).toBeInTheDocument()
  })

  it('renders without errors when the winner has left', async () => {
    await renderFinished({ others: [], room: { winner_player_id: 'gone' } })

    expect(screen.getByRole('heading', { name: 'Game Over!' })).toBeInTheDocument()
    expect(screen.getByText('Thanks for playing!')).toBeInTheDocument()
    expect(screen.queryByText(/wins!/)).not.toBeInTheDocument()
  })

  it('renders without errors when no winner was recorded', async () => {
    await renderFinished({ room: { winner_player_id: null } })

    expect(screen.getByText('Thanks for playing!')).toBeInTheDocument()
  })
})

describe('FinishedScreen: waiting for the host', () => {
  it('tells guests the host starts the next game', async () => {
    await renderFinished()

    expect(screen.getByText(/waiting for the host to start a new game/i)).toBeInTheDocument()
    expect(screen.queryByText(/rematch/i)).not.toBeInTheDocument()
  })

  it('does not show the message to the host', async () => {
    await renderFinished({ isHost: true })

    expect(screen.queryByText(/waiting for the host/i)).not.toBeInTheDocument()
  })
})

describe('FinishedScreen: host and guests', () => {
  it('host sees Play Again and Delete Room, and no Leave', async () => {
    const props = await renderFinished({ isHost: true })

    fireEvent.click(screen.getByRole('button', { name: /play again/i }))
    fireEvent.click(screen.getByRole('button', { name: /delete room/i }))

    expect(props.game.host.playAgain).toHaveBeenCalledTimes(1)
    expect(props.game.host.deleteRoom).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /leave room/i })).not.toBeInTheDocument()
  })

  it('host can reopen the game, below Edit Games Won', async () => {
    const props = await renderFinished({ isHost: true })

    const reopen = screen.getByRole('button', { name: 'Reopen Game' })
    const editWins = screen.getByRole('button', { name: /edit games won/i })
    expect(editWins.compareDocumentPosition(reopen) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(reopen)

    expect(props.game.host.reopenGame).toHaveBeenCalledTimes(1)
  })

  it('Reopen Game is disabled while it is running', async () => {
    await renderFinished({ isHost: true, busy: { reopenGame: true } })

    expect(screen.getByRole('button', { name: 'Reopen Game' })).toBeDisabled()
  })

  it('guests do not get Reopen Game', async () => {
    await renderFinished()

    expect(screen.queryByRole('button', { name: 'Reopen Game' })).not.toBeInTheDocument()
  })

  it('guests do not see Play Again and can leave', async () => {
    const props = await renderFinished()

    expect(screen.queryByRole('button', { name: /play again/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /leave room/i }))
    expect(props.game.leave).toHaveBeenCalledTimes(1)
  })

  it('Back to Home navigates home', async () => {
    const props = await renderFinished()

    fireEvent.click(screen.getByRole('button', { name: /back to home/i }))

    expect(props.game.goHome).toHaveBeenCalledTimes(1)
  })
})

describe('FinishedScreen: the game mode (X41)', () => {
  it('a finished Brutal game keeps its name, with no picker', async () => {
    await renderFinished({ isHost: true, room: { game_mode: 'brutal' }, theme: { mode: 'brutal' } })

    expect(screen.getByLabelText('Game mode: Brutal')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Change mode/ })).not.toBeInTheDocument()
  })


  it('offers the rules and the name, but not the picker, even to the host', async () => {
    await renderFinished({ isHost: true, room: { game_mode: 'vengeance' }, theme: { mode: 'vengeance' } })

    expect(screen.getByRole('button', { name: 'Rules' })).toBeInTheDocument()
    expect(screen.getByLabelText('Game mode: Vengeance')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Change mode/ })).not.toBeInTheDocument()
  })
})
