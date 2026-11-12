// The logo, the logo's dropdown and the header it sits in (X41).
import React, { useState } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import GameLogo from '@/pages/gameRoom/GameLogo'
import ModeShift from '@/components/game/ModeShift'
import RoomHeader from '@/pages/gameRoom/RoomHeader'
import { GAME_MODES, getRules } from '@/lib/gameRules'
import { makeRoom } from '../fixtures/renderGameHook.jsx'

const LOGO_NAME = /Game mode: .*Change/

function renderHeader({ room = makeRoom({ status: 'waiting' }), isHost = true, roundScores = [], setGameMode = vi.fn() } = {}) {
  const props = { room, isHost, roundScores, setGameMode, themeMode: room.game_mode }
  const view = render(<RoomHeader {...props} />)
  return { ...props, user: userEvent.setup(), rerenderWith: (changes) => view.rerender(<RoomHeader {...props} {...changes} />) }
}

function logoButton() {
  return screen.getByRole('button', { name: LOGO_NAME })
}

async function openPicker(user) {
  await user.click(logoButton())
  return screen.findByRole('radiogroup', { name: 'Game mode' })
}

describe('GameLogo', () => {
  it('Classic names itself in gold, with no tag', () => {
    render(<GameLogo mode="classic" />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName('Flip Classic')
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveTextContent('7')
    expect(screen.getByText('Classic').className).toContain('yellow')
    expect(screen.queryByText('Showdown')).not.toBeInTheDocument()
    expect(screen.queryByText('Vengeance')).not.toBeInTheDocument()
  })

  it('a missing mode reads as Classic', () => {
    render(<GameLogo />)

    expect(screen.getByText('Classic')).toBeInTheDocument()
  })

  it('Vengeance names itself in the wordmark, so colour is not the only signal', () => {
    render(<GameLogo mode="vengeance" />)

    expect(screen.getByText('Vengeance')).toBeInTheDocument()
    expect(screen.queryByText('Showdown')).not.toBeInTheDocument()
  })

  it('Vengeance\'s title is the same red as Brutal\'s', () => {
    expect(getRules('vengeance').wordmark.titleClass).toBe(getRules('brutal').wordmark.titleClass)
  })

  it('the brand logo is the app\'s name, with no mode', () => {
    render(<GameLogo isBrand size="large" />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName('Flip Showdown')
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveTextContent('7')
    expect(screen.getByText('Showdown')).toBeInTheDocument()
    expect(screen.queryByText('Classic')).not.toBeInTheDocument()
  })

  it('a small logo is a preview, not a page heading', () => {
    render(<GameLogo mode="vengeance" size="small" />)

    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    expect(screen.getByText('Vengeance')).toBeInTheDocument()
  })

  it('neither the room\'s logo nor the picker\'s say Showdown', async () => {
    const { user } = renderHeader()
    expect(within(logoButton()).queryByText('Showdown')).not.toBeInTheDocument()

    const picker = await openPicker(user)

    expect(within(picker).queryByText('Showdown')).not.toBeInTheDocument()
  })
})

describe('RoomHeader: who gets what', () => {
  it('a host in the waiting room gets a real button with an accessible name, closed', () => {
    renderHeader()

    expect(logoButton()).toHaveAttribute('aria-expanded', 'false')
    expect(logoButton().tagName).toBe('BUTTON')
  })

  it('a host in the first round with no scores still gets the button', () => {
    renderHeader({ room: makeRoom({ status: 'playing' }) })

    expect(logoButton()).toBeInTheDocument()
  })

  it('a guest gets the mode name and no way to change it', () => {
    renderHeader({ isHost: false, room: makeRoom({ status: 'waiting', game_mode: 'vengeance' }) })

    expect(screen.queryByRole('button', { name: LOGO_NAME })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Game mode: Vengeance')).toBeInTheDocument()
  })

  it('gives the mode name to screen readers only, so no logo has text under it', () => {
    const { unmount } = render(<RoomHeader room={makeRoom({ status: 'waiting', game_mode: 'brutal' })} themeMode="brutal" />)
    expect(screen.getByLabelText('Game mode: Brutal')).toHaveClass('sr-only')
    unmount()

    render(<RoomHeader room={makeRoom({ status: 'waiting' })} themeMode="classic" />)
    expect(screen.getByLabelText('Game mode: Classic')).toHaveClass('sr-only')
  })

  it('a host locked by a score gets the same read-only name', () => {
    renderHeader({ room: makeRoom({ status: 'playing' }), roundScores: [{ id: 's1' }] })

    expect(screen.queryByRole('button', { name: LOGO_NAME })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Game mode: Classic')).toBeInTheDocument()
  })

  it('a finished game does not offer the picker', () => {
    renderHeader({ room: makeRoom({ status: 'finished' }) })

    expect(screen.queryByRole('button', { name: LOGO_NAME })).not.toBeInTheDocument()
  })

  it('has no Rules button beside the logo, as each screen puts it at the bottom', () => {
    renderHeader({ isHost: false })

    expect(screen.queryByRole('button', { name: 'Rules' })).not.toBeInTheDocument()
  })

  it('the logo button names the mode on screen', () => {
    renderHeader({ room: makeRoom({ status: 'waiting', game_mode: 'vengeance' }) })

    expect(logoButton()).toHaveAccessibleName('Flip Vengeance. Game mode: Vengeance. Change mode')
  })

  it('the page heading stays named for the game, not for the button inside it', () => {
    renderHeader({ room: makeRoom({ status: 'waiting', game_mode: 'vengeance' }) })

    expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName('Flip Vengeance')
  })

  it('the button\'s name starts with the words on the logo (WCAG 2.5.3)', () => {
    renderHeader()

    expect(logoButton()).toHaveAccessibleName('Flip Classic. Game mode: Classic. Change mode')
    expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName('Flip Classic')
  })
})

describe('RoomHeader: the overlay for someone who can\'t change the mode', () => {
  const seeModes = () => screen.getByRole('button', { name: /See the modes$/ })

  it('a guest sees every mode, with the current one marked, and nothing to select', async () => {
    const user = userEvent.setup()
    render(<RoomHeader room={makeRoom({ status: 'waiting', game_mode: 'vengeance' })} themeMode="vengeance" />)

    await user.click(seeModes())

    const dialog = await screen.findByRole('dialog', { name: 'Game modes' })
    expect(within(dialog).getByText('This game\'s mode is ticked. Only the host can change it.')).toBeInTheDocument()
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument()
    for (const mode of GAME_MODES) {
      expect(within(dialog).getByText(mode.tagline)).toBeInTheDocument()
    }
    const cards = within(dialog).getAllByRole('listitem')
    expect(cards).toHaveLength(GAME_MODES.length)
    const current = cards.find((card) => card.getAttribute('data-game-mode') === 'vengeance')
    expect(within(current).getByText('Current mode')).toBeInTheDocument()
    expect(within(current).getByTestId('current-mode-check')).toBeInTheDocument()
  })

  it('tapping a mode changes nothing and leaves the overlay open', async () => {
    const setGameMode = vi.fn()
    const user = userEvent.setup()
    render(<RoomHeader room={makeRoom({ status: 'waiting' })} themeMode="classic" setGameMode={setGameMode} />)
    await user.click(seeModes())

    await user.click(await screen.findByText(getRules('brutal').tagline))

    expect(setGameMode).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Game modes' })).toBeInTheDocument()
  })

  it('Full rules opens over it and returns to it', async () => {
    const user = userEvent.setup()
    render(<RoomHeader room={makeRoom({ status: 'waiting' })} themeMode="classic" />)
    await user.click(seeModes())
    await user.click(await screen.findByRole('button', { name: 'Full rules for Brutal' }))
    expect(await screen.findByRole('tab', { name: /Brutal/ })).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{Escape}')

    expect(await screen.findByRole('dialog', { name: 'Game modes' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Full rules for Brutal' })).toHaveFocus())
  })

  it('focus starts on Close and returns to the logo', async () => {
    const user = userEvent.setup()
    render(<RoomHeader room={makeRoom({ status: 'waiting' })} themeMode="classic" />)
    await user.click(seeModes())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus())

    await user.keyboard('{Enter}')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(seeModes()).toHaveFocus()
  })

  it('a host locked by a score sees it too, with its own reason', async () => {
    const { user } = renderHeader({ room: makeRoom({ status: 'playing' }), roundScores: [{ id: 's1' }] })

    await user.click(seeModes())

    const dialog = await screen.findByRole('dialog', { name: 'Game modes' })
    expect(within(dialog).getByText('This game\'s mode is ticked. It can\'t be changed right now.')).toBeInTheDocument()
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument()
  })
})

describe('RoomHeader: the overlay', () => {
  it('opens by tap and lists every mode as a radio with its look, tagline and highlights', async () => {
    const { user } = renderHeader()

    const group = await openPicker(user)

    // The page under the open overlay is hidden from screen readers, the logo with it.
    expect(screen.getByRole('button', { name: LOGO_NAME, hidden: true })).toHaveAttribute('aria-expanded', 'true')
    const radios = within(group).getAllByRole('radio')
    expect(radios).toHaveLength(GAME_MODES.length)

    for (const mode of GAME_MODES) {
      const row = within(group).getByRole('radio', { name: mode.label }).closest('[data-game-mode]')
      expect(row).toHaveAttribute('data-game-mode', mode.id)
      expect(within(row).getByText(mode.tagline)).toBeInTheDocument()
      for (const highlight of mode.highlights) {
        expect(within(row).getByText(highlight)).toBeInTheDocument()
      }
    }
  })

  it('marks the current mode with a check as well as a highlight', async () => {
    const { user } = renderHeader({ room: makeRoom({ status: 'waiting', game_mode: 'vengeance' }) })

    const group = await openPicker(user)

    const current = within(group).getByRole('radio', { name: 'Vengeance' })
    expect(current).toHaveAttribute('aria-checked', 'true')
    expect(within(current).getByTestId('current-mode-check')).toBeInTheDocument()
    expect(within(group).getByRole('radio', { name: 'Classic' })).toHaveAttribute('aria-checked', 'false')
    expect(within(within(group).getByRole('radio', { name: 'Classic' })).queryByTestId('current-mode-check')).not.toBeInTheDocument()
  })

  // The picker opens with focus on the current mode's radio, so two rings would show every time.
  it('the current mode draws one ring, on its row, which thickens for focus', async () => {
    const { user } = renderHeader({ room: makeRoom({ status: 'waiting', game_mode: 'vengeance' }) })

    const group = await openPicker(user)

    const current = within(group).getByRole('radio', { name: 'Vengeance' })
    expect(current.className).not.toContain('focus-visible:ring-2')
    expect(current.parentElement.className).toContain('has-[[role=radio]:focus-visible]:ring-4')
    expect(within(group).getByRole('radio', { name: 'Classic' }).className).toContain('focus-visible:ring-2')
  })

  it('closes by its Close button, and focus returns to the logo', async () => {
    const { user } = renderHeader()
    await openPicker(user)

    await user.click(screen.getByRole('button', { name: 'Close' }))

    await waitFor(() => expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument())
    expect(logoButton()).toHaveFocus()
  })

  it('closes by Escape, and focus returns to the logo', async () => {
    const { user } = renderHeader()
    await openPicker(user)

    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument())
    expect(logoButton()).toHaveFocus()
  })

  it('closes by tapping the backdrop, and focus returns to the logo', async () => {
    const { user } = renderHeader()
    await openPicker(user)

    await user.click(screen.getByTestId('mode-picker-backdrop'))

    await waitFor(() => expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument())
    expect(logoButton()).toHaveFocus()
  })

  it('selecting a mode closes the overlay and asks for that mode', async () => {
    const { setGameMode, user } = renderHeader()
    const group = await openPicker(user)

    await user.click(within(group).getByRole('radio', { name: 'Vengeance' }))

    await waitFor(() => expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument())
    expect(setGameMode).toHaveBeenCalledWith('vengeance')
  })

  it('selecting the current mode only closes the overlay', async () => {
    const { setGameMode, user } = renderHeader()
    const group = await openPicker(user)

    await user.click(within(group).getByRole('radio', { name: 'Classic' }))

    await waitFor(() => expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument())
    expect(setGameMode).not.toHaveBeenCalled()
  })

  it('arrow keys move between modes without selecting one', async () => {
    const { setGameMode, user } = renderHeader()
    const group = await openPicker(user)
    const radios = within(group).getAllByRole('radio')
    radios[0].focus()

    for (const radio of radios.slice(1)) {
      await user.keyboard('{ArrowDown}')
      expect(radio).toHaveFocus()
    }
    await user.keyboard('{ArrowDown}')
    expect(radios[0]).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(radios[radios.length - 1]).toHaveFocus()

    expect(setGameMode).not.toHaveBeenCalled()
  })

  it('opens with focus on the current mode, so Enter straight away cannot apply another one', async () => {
    const { setGameMode, user } = renderHeader({ room: makeRoom({ status: 'waiting', game_mode: 'vengeance' }) })

    const group = await openPicker(user)

    await waitFor(() => expect(within(group).getByRole('radio', { name: 'Vengeance' })).toHaveFocus())
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument())
    expect(setGameMode).not.toHaveBeenCalled()
  })

  it('only one radio is in the tab order, and it follows the arrow keys', async () => {
    const { user } = renderHeader({ room: makeRoom({ status: 'waiting', game_mode: 'vengeance' }) })
    const group = await openPicker(user)
    const classic = within(group).getByRole('radio', { name: 'Classic' })
    const vengeance = within(group).getByRole('radio', { name: 'Vengeance' })
    await waitFor(() => expect(vengeance).toHaveFocus())

    expect(vengeance).toHaveAttribute('tabindex', '0')
    expect(classic).toHaveAttribute('tabindex', '-1')

    await user.keyboard('{ArrowUp}')

    expect(classic).toHaveFocus()
    expect(classic).toHaveAttribute('tabindex', '0')
    expect(vengeance).toHaveAttribute('tabindex', '-1')
  })

  it('arrow keys pressed on a Full rules button stay there, and do not jump between radios', async () => {
    const { user } = renderHeader()
    await openPicker(user)
    const fullRules = screen.getByRole('button', { name: 'Full rules for Classic' })
    fullRules.focus()

    await user.keyboard('{ArrowDown}')
    expect(fullRules).toHaveFocus()

    await user.keyboard('{ArrowUp}')
    expect(fullRules).toHaveFocus()
  })

  it('a radio\'s tagline and highlights reach screen readers, and its name stays the mode', async () => {
    const { user } = renderHeader()
    const group = await openPicker(user)

    for (const mode of GAME_MODES) {
      const radio = within(group).getByRole('radio', { name: mode.label })
      expect(radio).toHaveAccessibleDescription(expect.stringContaining(mode.tagline))
      expect(radio).toHaveAccessibleDescription(expect.stringContaining(mode.highlights[0]))
    }
  })

  it('the overlay has an accessible name', async () => {
    const { user } = renderHeader()

    await openPicker(user)

    expect(screen.getByRole('dialog', { name: 'Choose a game mode' })).toBeInTheDocument()
  })

  it('Full rules opens over the overlay, and closing the sheet returns to it with focus on that button', async () => {
    const { user } = renderHeader()
    await openPicker(user)
    await user.click(screen.getByRole('button', { name: 'Full rules for Vengeance' }))
    await screen.findByRole('tab', { name: /Vengeance/ })
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { hidden: true })).toBeInTheDocument()

    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('tab', { name: /Vengeance/ })).not.toBeInTheDocument())
    expect(await screen.findByRole('radiogroup', { name: 'Game mode' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Full rules for Vengeance' })).toHaveFocus()
  })

  it('a change from elsewhere closes the overlay under an open sheet, and focus ends on the logo', async () => {
    const { user, rerenderWith } = renderHeader()
    await openPicker(user)
    await user.click(screen.getByRole('button', { name: 'Full rules for Vengeance' }))
    await screen.findByRole('tab', { name: /Vengeance/ })

    rerenderWith({ room: makeRoom({ status: 'waiting', game_mode: 'vengeance' }), themeMode: 'vengeance' })
    await waitFor(() => expect(screen.queryByRole('radiogroup', { hidden: true })).not.toBeInTheDocument())
    expect(screen.getByRole('tab', { name: /Vengeance/ })).toBeInTheDocument()

    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('tab', { name: /Vengeance/ })).not.toBeInTheDocument())
    expect(logoButton()).toHaveFocus()
  })

  it('Full rules opens that tab of the rules sheet and does not change the selection', async () => {
    const { setGameMode, user } = renderHeader()
    const group = await openPicker(user)
    const row = within(group).getByRole('radio', { name: 'Vengeance' }).closest('[data-game-mode]')

    await user.click(within(row).getByRole('button', { name: 'Full rules for Vengeance' }))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Vengeance/ })).toHaveAttribute('aria-selected', 'true')
    expect(setGameMode).not.toHaveBeenCalled()
  })

  it('closes when the mode changes through another device', async () => {
    const { user, rerenderWith } = renderHeader()
    await openPicker(user)

    rerenderWith({ room: makeRoom({ status: 'waiting', game_mode: 'vengeance' }), themeMode: 'vengeance' })

    await waitFor(() => expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument())
  })

  it('closes when a score locks the mode', async () => {
    const room = makeRoom({ status: 'playing' })
    const { user, rerenderWith } = renderHeader({ room })
    await openPicker(user)

    rerenderWith({ roundScores: [{ id: 's1' }] })

    await waitFor(() => expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument())
    expect(screen.getByLabelText('Game mode: Classic')).toBeInTheDocument()
  })
})

describe('ModeShift', () => {
  function shiftTo(mode, overrides = {}) {
    return { id: 1, to: mode, coverMs: 400, fadeMs: 400, isCrossFade: false, ...overrides }
  }

  it('renders nothing with no shift', () => {
    const { container } = render(<ModeShift shift={null} />)

    expect(container).toBeEmptyDOMElement()
  })

  it('never gets in the way: no pointer events, hidden from screen readers, under dialogs', () => {
    render(<ModeShift shift={shiftTo('vengeance')} />)

    const layer = screen.getByTestId('mode-shift')
    expect(layer).toHaveAttribute('aria-hidden', 'true')
    expect(layer.className).toContain('pointer-events-none')
    // Above the toggles (z-40), below dialogs (z-50) and full-size chat emoji (z-200).
    expect(layer.className).toContain('z-[45]')
  })

  it('takes its colours from the mode it is shifting to', () => {
    render(<ModeShift shift={shiftTo('vengeance')} />)

    expect(screen.getByTestId('mode-shift').style.background).toContain('radial-gradient')
    expect(getRules('vengeance').mood.background).toContain('radial-gradient')
  })

  it('centres its glow on the point it spreads from, rather than on the screen', () => {
    for (const mode of ['classic', 'vengeance']) {
      expect(getRules(mode).mood.background).toContain('circle at var(--mode-shift-origin)')
    }

    render(<ModeShift shift={shiftTo('vengeance')} />)

    expect(screen.getByTestId('mode-shift').style.getPropertyValue('--mode-shift-origin')).not.toBe('')
  })

  it('spreads from the logo', () => {
    render(
      <>
        <GameLogo mode="classic" />
        <ModeShift shift={shiftTo('vengeance')} />
      </>,
    )

    expect(screen.getByTestId('mode-shift').style.clipPath).toContain('circle')
  })

  it('under reduced motion it has no moving circle', () => {
    render(<ModeShift shift={shiftTo('vengeance', { isCrossFade: true, coverMs: 100, fadeMs: 100 })} />)

    expect(screen.getByTestId('mode-shift').style.clipPath).toBe('')
  })
})

describe('the header with the room around it', () => {
  // The room only changes when the server's update arrives, for the host too.
  function LiveHeader() {
    const [room, setRoom] = useState(makeRoom({ status: 'waiting' }))
    return (
      <RoomHeader
        room={room}
        themeMode={room.game_mode}
        isHost
        roundScores={[]}
        setGameMode={(mode) => setRoom({ ...room, game_mode: mode })}
      />
    )
  }

  it('the name on the logo follows the room', async () => {
    const user = userEvent.setup()
    render(<LiveHeader />)
    const group = await openPicker(user)

    await user.click(within(group).getByRole('radio', { name: 'Vengeance' }))

    await waitFor(() => expect(logoButton()).toHaveAccessibleName(/Game mode: Vengeance\. Change mode$/))
  })
})

describe('the official game each mode is for (X71)', () => {
  it('each mode in the picker says which official game it is for, in words', async () => {
    const { user } = renderHeader()
    const group = await openPicker(user)

    expect(within(group).getByRole('radio', { name: 'Classic' })).toHaveAccessibleDescription(/For Flip 7\b/)
    expect(within(group).getByRole('radio', { name: 'Vengeance' })).toHaveAccessibleDescription(/For Flip 7: With a Vengeance/)
    expect(within(group).getByRole('radio', { name: 'Brutal' })).toHaveAccessibleDescription(/House rules for Flip 7: With a Vengeance/)
  })
})

describe('the logo card and its fit (X72)', () => {
  it('every logo carries the decorative card, hidden from screen readers', () => {
    render(<GameLogo mode="vengeance" />)

    const card = document.querySelector('[data-logo-card]')
    expect(card).toHaveAttribute('aria-hidden', 'true')
    expect(card.style.height).toMatch(/em$/)
  })

  it('without a canvas, SHOWDOWN and the titles take the default fit', () => {
    const { unmount } = render(<GameLogo isBrand size="large" />)
    expect(screen.getByText('Showdown').style.letterSpacing).toBe('0.12em')
    unmount()

    render(<GameLogo mode="classic" />)
    expect(screen.getByText('Classic').style.letterSpacing).toBe('0.41em')
  })
})

describe('the brand logo\'s softer FLIP (X72)', () => {
  it('fades FLIP on the brand logo but keeps it white in a room', () => {
    const { unmount } = render(<GameLogo isBrand size="large" />)
    expect(screen.getByText('FLIP', { exact: false }).className).toContain('from-indigo-50')
    unmount()

    render(<GameLogo mode="classic" />)
    expect(screen.getByText('FLIP', { exact: false }).className).toContain('text-white')
  })
})
