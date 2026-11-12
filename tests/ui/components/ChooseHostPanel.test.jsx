// ChooseHostPanel.
import React from 'react'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChooseHostPanel from '@/components/game/ChooseHostPanel'
import { emitRealtime, resetFakeApi } from '../fixtures/fakeApi.jsx'
import { makePlayer } from '../fixtures/renderGameHook.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

// Every test gets its own room.
let roomCounter = 0
let roomId = ''

beforeEach(() => {
  resetFakeApi({})
  roomCounter += 1
  roomId = `panel-room-${roomCounter}`
})

const ME = makePlayer('me', { name: 'Me', online: true })

function renderPanel(players, currentPlayer = ME) {
  return render(<ChooseHostPanel roomId={roomId} players={players} currentPlayer={currentPlayer} />)
}

function onlineHost() {
  return makePlayer('host', { name: 'Hostess', is_host: true, online: true })
}

function offlineHost() {
  return makePlayer('host', { name: 'Hostess', is_host: true, online: false })
}

function bo() {
  return makePlayer('p2', { name: 'Bo', online: true })
}

// The server leaves the host out of `eligible` once it counts them as offline.
function sendVote({ unlocksInMs = 0, eligible = ['me', 'p2'] } = {}) {
  act(() => {
    emitRealtime('vote', {
      type: 'vote',
      room_id: roomId,
      topic: 'make-host',
      eligible,
      holds: [],
      pending: null,
      unlocks_in_ms: unlocksInMs,
    })
  })
}

describe('as a player, with the host online', () => {
  it('shows nothing', () => {
    const { container } = renderPanel([onlineHost(), ME, bo()])

    sendVote({ eligible: ['host', 'me', 'p2'] })

    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing without a current player', () => {
    const { container } = renderPanel([offlineHost()], null)

    expect(container).toBeEmptyDOMElement()
  })
})

describe('as a player, while the host has just gone offline', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the countdown and nothing to vote on', () => {
    renderPanel([offlineHost(), ME, bo()])

    sendVote({ unlocksInMs: 101_500 })

    expect(screen.getByText('Vote for a new host')).toBeInTheDocument()
    expect(screen.getByText(/opens in 1:42/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('counts down and opens the vote once the wait is over', () => {
    vi.useFakeTimers()
    renderPanel([offlineHost(), ME, bo()])
    sendVote({ unlocksInMs: 2_000 })

    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(screen.getByText(/opens in 0:01/)).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(screen.queryByText(/opens in/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hold to vote for Bo' })).toBeInTheDocument()
  })

  it('goes away if the host comes back', () => {
    const { container, rerender } = renderPanel([offlineHost(), ME, bo()])
    sendVote({ unlocksInMs: 30_000 })

    rerender(<ChooseHostPanel roomId={roomId} players={[onlineHost(), ME, bo()]} currentPlayer={ME} />)

    expect(container).toBeEmptyDOMElement()
  })

  // Presence arrives just before the `vote` message, and the old message reads as "no wait".
  it('does not open the vote on a message from before the host went offline', () => {
    const { container } = renderPanel([offlineHost(), ME, bo()])

    sendVote({ unlocksInMs: 0, eligible: ['host', 'me', 'p2'] })

    expect(container).toBeEmptyDOMElement()
  })

  it('shows nothing until the first vote message says how long is left', () => {
    const { container } = renderPanel([offlineHost(), ME, bo()])

    expect(container).toBeEmptyDOMElement()
  })
})

describe('as a player, once the host has been offline long enough', () => {
  it('shows the vote open, and it can not be collapsed', () => {
    renderPanel([offlineHost(), ME, bo()])

    sendVote()

    expect(screen.getByText(/The host is offline./)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hold to vote for Bo' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Vote for a new host' })).toBeDisabled()
  })

  it('offers each online non-host player, including me', () => {
    renderPanel([offlineHost(), ME, bo(), makePlayer('p3', { name: 'Cy', online: false })])

    sendVote()

    expect(screen.getByRole('button', { name: 'Hold to vote for Me' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hold to vote for Bo' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Hold to vote for Cy' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Hold to vote for Hostess' })).not.toBeInTheDocument()
  })

  it('treats me as online even when my presence lags', () => {
    const laggingMe = makePlayer('me', { name: 'Me', online: false })
    renderPanel([offlineHost(), laggingMe], laggingMe)

    sendVote({ eligible: ['me'] })

    expect(screen.getByRole('button', { name: 'Hold to vote for Me' })).toBeInTheDocument()
  })
})

describe('as the host', () => {
  const meAsHost = makePlayer('me', { name: 'Me', is_host: true, online: true })

  it('shows a collapsed section that toggles open and closed', async () => {
    const user = userEvent.setup()
    renderPanel([meAsHost, bo()], meAsHost)
    const header = screen.getByRole('button', { name: 'Choose a new host' })
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: /Hold to vote/ })).not.toBeInTheDocument()

    await user.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Hold to vote for Bo' })).toBeInTheDocument()

    await user.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'Hold to vote for Bo' })).not.toBeInTheDocument()
  })

  it('offers the other online players to hand over to, no vote needed', async () => {
    const user = userEvent.setup()
    renderPanel([meAsHost, bo()], meAsHost)

    await user.click(screen.getByRole('button', { name: 'Choose a new host' }))

    expect(screen.getByText('Press and hold a player for 3 seconds to make them the host.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hold to vote for Bo' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Hold to vote for Me' })).not.toBeInTheDocument()
  })
})
