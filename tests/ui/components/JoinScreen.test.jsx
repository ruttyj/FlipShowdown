// JoinScreen: prefilled name, blocked empty name, busy join button, in-app browser hint.
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import JoinScreen from '@/pages/gameRoom/JoinScreen'
import { makePlayer, makeRoom, ROOM_CODE } from '../fixtures/renderGameHook.jsx'

const IN_APP_USER_AGENT = 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 [FBAN/FBIOS;FBAV/400.0]'
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36'
const HINT = /inside another app.s browser/i

afterEach(() => {
  vi.restoreAllMocks()
})

function renderJoin(props = {}) {
  const allProps = {
    room: makeRoom({ status: 'waiting' }),
    roomCode: ROOM_CODE,
    players: [],
    playerName: 'Player One',
    setPlayerName: vi.fn(),
    joinRoom: vi.fn(),
    isJoining: false,
    ...props,
  }
  render(<JoinScreen {...allProps} />)
  return allProps
}

function useUserAgent(userAgent) {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(userAgent)
}

describe('JoinScreen', () => {
  it('a Brutal room shows its themed logo and name', () => {
    renderJoin({ room: makeRoom({ status: 'waiting', game_mode: 'brutal' }), themeMode: 'brutal' })

    expect(screen.getByText('Brutal', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByLabelText('Game mode: Brutal')).toBeInTheDocument()
  })


  it('shows the room code and the prefilled name, and joins on click', () => {
    const props = renderJoin()

    expect(screen.getByText(`Room: ${ROOM_CODE}`)).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Enter your name')).toHaveValue('Player One')

    fireEvent.click(screen.getByRole('button', { name: /join room/i }))
    expect(props.joinRoom).toHaveBeenCalledTimes(1)
  })

  it('reports typed names', () => {
    const props = renderJoin()

    fireEvent.change(screen.getByPlaceholderText('Enter your name'), { target: { value: 'Sam' } })

    expect(props.setPlayerName).toHaveBeenCalledWith('Sam')
  })

  it('blocks an empty or blank name', () => {
    const props = renderJoin({ playerName: '   ' })

    const button = screen.getByRole('button', { name: /join room/i })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(props.joinRoom).not.toHaveBeenCalled()
  })

  it('disables the join button while joining', () => {
    renderJoin({ isJoining: true })

    expect(screen.getByRole('button', { name: /join room/i })).toBeDisabled()
  })

  it('lists the players already in the room', () => {
    renderJoin({ players: [makePlayer('p2', { name: 'Ann' }), makePlayer('p3', { name: 'Bo' })] })

    expect(screen.getByText('Already in this room')).toBeInTheDocument()
    expect(screen.getByText('Ann, Bo')).toBeInTheDocument()
  })

  it('shows the open-in-your-browser hint in an in-app browser', () => {
    useUserAgent(IN_APP_USER_AGENT)
    renderJoin()

    expect(screen.getByText(HINT)).toBeInTheDocument()
  })

  it('hides the hint in a normal browser', () => {
    useUserAgent(BROWSER_USER_AGENT)
    renderJoin()

    expect(screen.queryByText(HINT)).not.toBeInTheDocument()
  })
})

describe('JoinScreen: the room mode', () => {
  it('shows the themed logo and the mode name, before joining', () => {
    renderJoin({ room: makeRoom({ status: 'waiting', game_mode: 'vengeance' }), themeMode: 'vengeance' })

    expect(screen.getByText('Vengeance', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByLabelText('Game mode: Vengeance')).toBeInTheDocument()
  })

  it('has the Rules button', () => {
    renderJoin()

    expect(screen.getByRole('button', { name: 'Rules' })).toBeInTheDocument()
  })
})
