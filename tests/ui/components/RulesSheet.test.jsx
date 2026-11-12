// The rules sheet (§3.9): one tab per mode, opened on the room's mode. It only explains.
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import ManualScoreEntry from '@/components/game/ManualScoreEntry'
import { RulesButton } from '@/components/game/RulesSheet'
import { UNOFFICIAL_DISCLAIMER } from '@/lib/disclaimer'
import { GAME_MODES } from '@/lib/gameRules'

async function openRules(props = {}) {
  const user = userEvent.setup()
  render(<RulesButton gameMode="vengeance" maxScore={150} {...props} />)
  await user.click(screen.getByRole('button', { name: 'Rules' }))
  const dialog = await screen.findByRole('dialog')
  return { user, dialog }
}

describe('RulesButton', () => {
  it('has one tab per mode, opened on the room mode and marked as this game', async () => {
    const { dialog } = await openRules()

    expect(within(dialog).getAllByRole('tab')).toHaveLength(GAME_MODES.length)
    const roomTab = within(dialog).getByRole('tab', { name: /Vengeance/ })
    expect(roomTab).toHaveAttribute('aria-selected', 'true')
    expect(roomTab).toHaveTextContent('This game')
    expect(within(dialog).getByRole('tab', { name: /Classic/ })).not.toHaveTextContent('This game')
  })

  it('a room with no mode opens on Classic', async () => {
    const { dialog } = await openRules({ gameMode: undefined })

    expect(within(dialog).getByRole('tab', { name: /Classic/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('shows the real target of the room', async () => {
    const { dialog } = await openRules()

    expect(within(dialog).getByText(/Be the player/)).toHaveTextContent(/200 150 or more/)
  })

  it('shows the scoring example, the rulings and the official PDF', async () => {
    const { dialog } = await openRules()

    expect(within(dialog).getByText(/48 becomes 24/)).toBeInTheDocument()
    expect(within(dialog).getByText(/plain 7 must have come after it/)).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: /official rulebook/i })).toHaveAttribute(
      'href',
      expect.stringContaining('.pdf'),
    )
  })

  it('Vengeance compares each change with Classic, starting with staying', async () => {
    const { dialog } = await openRules()

    const heading = within(dialog).getByRole('heading', { name: "What's changed from Classic" })
    const staying = within(dialog).getByRole('heading', { name: 'Staying' }).parentElement

    expect(heading.parentElement.contains(staying)).toBe(true)
    expect(within(staying).getByText('Classic')).toBeInTheDocument()
    expect(within(staying).getByText('Vengeance')).toBeInTheDocument()
    expect(within(staying).getByText(/still be targeted/)).toBeInTheDocument()
  })

  it('Brutal compares each change with Vengeance', async () => {
    const { dialog, user } = await openRules()

    await user.click(within(dialog).getByRole('tab', { name: /Brutal/ }))

    expect(within(dialog).getByRole('heading', { name: "What's changed from Vengeance" })).toBeInTheDocument()
    const flip7 = within(dialog).getByRole('heading', { name: 'A Flip 7' }).parentElement
    expect(within(flip7).getByText('Vengeance')).toBeInTheDocument()
    expect(within(flip7).getByText('Brutal')).toBeInTheDocument()
    expect(within(flip7).getByText(/−15 for another player/)).toBeInTheDocument()
  })

  it('separates what the publisher answered from what the table decides', async () => {
    const { dialog } = await openRules()

    expect(within(dialog).getByRole('heading', { name: 'Edge cases the publisher has answered' })).toBeInTheDocument()
    expect(within(dialog).getByRole('heading', { name: 'Edge cases with no official answer' })).toBeInTheDocument()
    expect(within(dialog).getByText(/your table has the final say/)).toBeInTheDocument()
    expect(within(dialog).getByText(/No suitable target/)).toBeInTheDocument()
  })

  it('links the publisher FAQ beside the rulebook', async () => {
    const { dialog } = await openRules()

    expect(within(dialog).getByRole('link', { name: /FAQ/ })).toHaveAttribute('href', expect.stringContaining('flip-7-wav-faqs'))
  })

  it('another tab shows that mode, and Classic links its own PDF', async () => {
    const { dialog, user } = await openRules()

    await user.click(within(dialog).getByRole('tab', { name: /Classic/ }))

    expect(within(dialog).getByText(/Freeze: the target has to stay/)).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: /official rulebook/i })).toHaveAttribute(
      'href',
      expect.stringContaining('FLIP_7_TB_RULES'),
    )
  })

  it('the tabs scroll sideways rather than wrap', async () => {
    const { dialog } = await openRules()

    expect(within(dialog).getByRole('tablist').className).toContain('overflow-x-auto')
  })

  it('strikes through the default target when the room has changed it', async () => {
    const { dialog } = await openRules()

    expect(dialog.querySelector('s')).toHaveTextContent('200')
  })

  it('shows the default target plainly when the room keeps it', async () => {
    const { dialog } = await openRules({ maxScore: 200 })

    expect(within(dialog).getByText(/Be the player/)).toHaveTextContent(/has 200 or more/)
    expect(dialog.querySelector('s')).toBeNull()
  })

  it('closing the sheet leaves focus on the button that opened it', async () => {
    const user = userEvent.setup()
    render(<RulesButton gameMode="classic" />)
    await user.click(screen.getByRole('button', { name: 'Rules' }))
    await screen.findByRole('tab', { name: /Classic/ })

    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('tab', { name: /Classic/ })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Rules' })).toHaveFocus()
  })

  it('can be read from inside score entry', async () => {
    const user = userEvent.setup()
    render(<ManualScoreEntry gameMode="vengeance" maxScore={150} onScoreConfirmed={vi.fn()} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Rules' }))

    expect(within(await screen.findByRole('dialog')).getByText(/Be the player/)).toHaveTextContent(/150 or more/)
  })
})

describe('RulesButton: unofficial disclaimer (X67)', () => {
  it('shows the disclaimer next to the rulebook and FAQ links', async () => {
    const { dialog } = await openRules()

    expect(within(dialog).getByText(UNOFFICIAL_DISCLAIMER)).toBeInTheDocument()
  })
})

describe('RulesButton: the official game (X71)', () => {
  it('each tab opens by naming the official game the mode is for', async () => {
    const { user, dialog } = await openRules()

    expect(within(dialog).getByText('For Flip 7: With a Vengeance')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('tab', { name: /Brutal/ }))
    expect(within(dialog).getByText('House rules for Flip 7: With a Vengeance')).toBeInTheDocument()
  })
})
