// W5.4: GamesWonEditor.
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import GamesWonEditor from '@/components/game/GamesWonEditor'

const players = [
  { id: 'p1', name: 'Ann', games_won: 2 },
  { id: 'p2', name: 'Bob' },
]

function renderEditor(overrides = {}) {
  const props = {
    players,
    onSave: vi.fn().mockResolvedValue({ ok: true }),
    isSaving: false,
    onClose: vi.fn(),
    ...overrides,
  }
  render(<GamesWonEditor {...props} />)
  return props
}

describe('GamesWonEditor', () => {
  it('shows each player with their current count, defaulting to 0', () => {
    renderEditor()

    expect(screen.getByRole('spinbutton', { name: 'Ann games won' })).toHaveValue(2)
    expect(screen.getByRole('spinbutton', { name: 'Bob games won' })).toHaveValue(0)
  })

  it('saves edited counts, keeps untouched ones, and closes on success', async () => {
    const props = renderEditor()
    const bob = screen.getByRole('spinbutton', { name: 'Bob games won' })
    await userEvent.clear(bob)
    await userEvent.type(bob, '4')

    await userEvent.click(screen.getByRole('button', { name: /save changes/i }))

    expect(props.onSave).toHaveBeenCalledWith({ p1: 2, p2: 4 })
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('sends 0 for a blank or negative entry', async () => {
    const props = renderEditor()
    await userEvent.clear(screen.getByRole('spinbutton', { name: 'Ann games won' }))
    const bob = screen.getByRole('spinbutton', { name: 'Bob games won' })
    await userEvent.clear(bob)
    await userEvent.type(bob, '-3')

    await userEvent.click(screen.getByRole('button', { name: /save changes/i }))

    expect(props.onSave).toHaveBeenCalledWith({ p1: 0, p2: 0 })
  })

  it('stays open when the save fails', async () => {
    const props = renderEditor({ onSave: vi.fn().mockResolvedValue(null) })

    await userEvent.click(screen.getByRole('button', { name: /save changes/i }))

    expect(props.onSave).toHaveBeenCalledTimes(1)
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('Cancel closes without saving', async () => {
    const props = renderEditor()

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(props.onSave).not.toHaveBeenCalled()
  })

  it('disables Save while saving', () => {
    renderEditor({ isSaving: true })

    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled()
  })
})
