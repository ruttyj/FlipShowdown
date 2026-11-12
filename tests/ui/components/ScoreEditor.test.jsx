import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import ScoreEditor from '@/components/game/ScoreEditor'

const PLAYERS = [
  { id: 'p1', name: 'Ada', total_score: 12 },
  { id: 'p2', name: 'Bo', total_score: 5 },
]

const SCORES = [
  { player_id: 'p1', round_number: 1, final_score: 12, cards: [{ type: 'number', value: '12' }] },
  { player_id: 'p2', round_number: 2, final_score: 5, cards: [{ type: 'number', value: '5' }] },
]

function renderEditor(props = {}) {
  const onSaveScore = vi.fn().mockResolvedValue({ ok: true })
  const onClose = vi.fn()
  const view = render(
    <ScoreEditor
      players={PLAYERS}
      roundScores={SCORES}
      room={{ current_round: 3 }}
      onSaveScore={onSaveScore}
      onClose={onClose}
      isSaving={false}
      isClosing={false}
      {...props}
    />
  )
  return { onSaveScore, onClose, user: userEvent.setup(), ...view }
}

const saveButton = () => screen.findByRole('button', { name: /^save$/i })

function cardsOfCount(count) {
  return Array.from({ length: count }, (_, index) => ({ type: 'number', value: String(index) }))
}

describe('ScoreEditor', () => {
  // --- The card limit ---

  it('disables Save and says why above 30 cards', async () => {
    renderEditor({ initialEdit: { player_id: 'p1', round_number: 1, cards: cardsOfCount(31) } })

    expect(screen.getByRole('alert')).toHaveTextContent('at most 30 cards')
    expect(await saveButton()).toBeDisabled()
  })

  it('disables Save above 30 cards on a busted hand too, as the server refuses it all the same', async () => {
    renderEditor({ initialEdit: { player_id: 'p1', round_number: 1, busted: true, cards: cardsOfCount(31) } })

    expect(await saveButton()).toBeDisabled()
  })

  it('keeps Save enabled at exactly 30 cards', async () => {
    renderEditor({ initialEdit: { player_id: 'p1', round_number: 1, cards: cardsOfCount(30) } })

    expect(await saveButton()).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('blank rows do not count toward the limit', async () => {
    const cards = [...cardsOfCount(30), { type: 'number', value: '' }]
    renderEditor({ initialEdit: { player_id: 'p1', round_number: 1, cards } })

    expect(await saveButton()).toBeEnabled()
  })

  // --- Everything else ---

  it('lists every round with scores plus the current round', () => {
    renderEditor()

    expect(screen.getByText('R1')).toBeInTheDocument()
    expect(screen.getByText('R2')).toBeInTheDocument()
    expect(screen.getByText('R3')).toBeInTheDocument()
    expect(screen.queryByText('R4')).not.toBeInTheDocument()
  })

  it('opens straight on initialEdit with its cards', () => {
    renderEditor({ initialEdit: { player_id: 'p2', round_number: 2, cards: SCORES[1].cards } })

    expect(screen.getByText('Editing: Bo')).toBeInTheDocument()
    expect(screen.getByText('Round 2')).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Card 1 value' })).toHaveValue(5)
  })

  it('opens a stored score with its modifier signs stripped (X34)', () => {
    const cards = [{ type: 'number', value: '5' }, { type: 'adder', value: '+4' }]
    renderEditor({ initialEdit: { player_id: 'p2', round_number: 2, cards } })

    expect(screen.getByRole('spinbutton', { name: 'Card 2 value' })).toHaveValue(4)
  })

  // X39: opening a stored score to look at or tweak it must not raise the phone keyboard.
  it('opens a score from the grid with no value field focused (X39)', async () => {
    const { user } = renderEditor()

    await user.click(screen.getByRole('button', { name: 'Edit round 1 score for Ada' }))

    expect(await screen.findByRole('spinbutton', { name: 'Card 1 value' })).toBeInTheDocument()
    expect(document.activeElement.tagName).not.toBe('INPUT')
  })

  it('opens straight on initialEdit with no value field focused (X39)', () => {
    renderEditor({ initialEdit: { player_id: 'p2', round_number: 2, cards: SCORES[1].cards } })

    expect(screen.getByRole('spinbutton', { name: 'Card 1 value' })).toBeInTheDocument()
    expect(document.activeElement.tagName).not.toBe('INPUT')
  })

  it('removing a card in the editor focuses no value field (X39)', async () => {
    const cards = [{ type: 'number', value: '5' }, { type: 'number', value: '7' }]
    const { user } = renderEditor({ initialEdit: { player_id: 'p1', round_number: 1, cards } })

    await user.click(screen.getByRole('button', { name: 'Remove card 1' }))

    expect(screen.getAllByRole('spinbutton')).toHaveLength(1)
    expect(document.activeElement.tagName).not.toBe('INPUT')
  })

  it('an add button in the editor still focuses the new row (X39)', async () => {
    const { user } = renderEditor({ initialEdit: { player_id: 'p2', round_number: 2, cards: SCORES[1].cards } })

    await user.click(screen.getByRole('button', { name: 'Add card' }))

    expect(screen.getByRole('spinbutton', { name: 'Card 2 value' })).toHaveFocus()
  })

  it('saves and returns to the grid on success', async () => {
    const { user, onSaveScore } = renderEditor()

    await user.click(screen.getByRole('button', { name: 'Edit round 1 score for Ada' }))
    await user.click(await saveButton())

    expect(onSaveScore).toHaveBeenCalledWith(expect.objectContaining({
      player_id: 'p1',
      round_number: 1,
      final_score: 12,
      cards: [{ type: 'number', value: '12' }],
    }))
    expect(await screen.findByRole('button', { name: 'Done Editing' })).toBeInTheDocument()
  })

  it('stays on the editor when the save fails', async () => {
    const onSaveScore = vi.fn().mockResolvedValue(null)
    const { user } = renderEditor({ onSaveScore })

    await user.click(screen.getByRole('button', { name: 'Edit round 1 score for Ada' }))
    await user.click(await saveButton())

    expect(onSaveScore).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Editing: Ada')).toBeInTheDocument()
  })

  it('Done Editing closes, and is disabled while closing', async () => {
    const { user, onClose, rerender } = renderEditor()

    await user.click(screen.getByRole('button', { name: 'Done Editing' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    rerender(
      <ScoreEditor players={PLAYERS} roundScores={SCORES} room={{ current_round: 3 }}
        onSaveScore={vi.fn()} onClose={onClose} isClosing />
    )
    expect(screen.getByRole('button', { name: 'Done Editing' })).toBeDisabled()
  })

  it('saves a 0 score with no cards when every card is removed', async () => {
    const { user, onSaveScore } = renderEditor()

    await user.click(screen.getByRole('button', { name: 'Edit round 1 score for Ada' }))
    await user.click(await screen.findByRole('button', { name: 'Remove card 1' }))
    await user.click(await saveButton())

    expect(onSaveScore).toHaveBeenCalledWith(expect.objectContaining({
      player_id: 'p1', cards: [], base_sum: 0, final_score: 0,
    }))
  })

  it('drops blank cards of every type before saving', async () => {
    const cards = [
      { type: 'number', value: '4' },
      { type: 'number', value: '' },
      { type: 'multiplier', value: '  ' },
      { type: 'divisor', value: '' },
    ]
    const { user, onSaveScore } = renderEditor({ initialEdit: { player_id: 'p1', round_number: 1, cards } })

    await user.click(await saveButton())

    expect(onSaveScore).toHaveBeenCalledWith(expect.objectContaining({
      cards: [{ type: 'number', value: '4' }], base_sum: 4, final_score: 4,
    }))
  })

  it('does not floor a negative score at 0', async () => {
    const cards = [{ type: 'number', value: '2' }, { type: 'subtractor', value: '-4' }]
    const { user, onSaveScore } = renderEditor({ initialEdit: { player_id: 'p1', round_number: 1, cards } })

    await user.click(await saveButton())

    expect(onSaveScore).toHaveBeenCalledWith(expect.objectContaining({ final_score: -2 }))
  })

  // --- The Bust switch (X45) --------------------------------------------------------

  describe('the Bust switch', () => {
    // The editor slides in, so a switch found right after a tap has to be waited for.
    const bustSwitch = () => screen.findByRole('switch', { name: 'Bust' })
    const BUSTED = { player_id: 'p1', round_number: 1, final_score: 0, busted: true, cards: [] }

    it('the grid shows a bust as BUST, named for the host', () => {
      renderEditor({ roundScores: [BUSTED] })

      const cell = screen.getByRole('button', { name: 'Edit round 1 score for Ada (busted, 0 points)' })
      expect(cell).toHaveTextContent('BUST')
    })

    it('the grid says "minus" in the name of a negative bust', () => {
      renderEditor({ roundScores: [{ ...BUSTED, final_score: -6 }] })

      const cell = screen.getByRole('button', { name: 'Edit round 1 score for Ada (busted, minus 6 points)' })
      expect(cell).toHaveTextContent('−6')
    })

    it('a plain 0 in the grid isn\'t red', () => {
      renderEditor({ roundScores: [{ ...BUSTED, busted: false }] })

      expect(screen.getByRole('button', { name: 'Edit round 1 score for Ada' }).querySelector('.text-red-500')).toBeNull()
    })

    it('a score that is not a bust opens with it off', async () => {
      const { user } = renderEditor()

      await user.click(screen.getByRole('button', { name: 'Edit round 1 score for Ada' }))

      expect(await bustSwitch()).not.toBeChecked()
    })

    it('turning it on keeps the cards and scores a bust', async () => {
      const { user, onSaveScore } = renderEditor({ initialEdit: { player_id: 'p2', round_number: 2, cards: SCORES[1].cards } })

      await user.click(await bustSwitch())

      expect(screen.getByRole('spinbutton', { name: 'Card 1 value' })).toHaveValue(5)
      await user.click(await saveButton())
      expect(onSaveScore).toHaveBeenCalledWith(expect.objectContaining({
        cards: SCORES[1].cards,
        final_score: 0,
        busted: true,
      }))
    })

    it('a stored bust opens with it on, and turning it off rescores the stored cards', async () => {
      const cards = [{ type: 'number', value: '9' }]
      const { user, onSaveScore } = renderEditor({ roundScores: [{ ...BUSTED, cards }] })
      await user.click(screen.getByRole('button', { name: /Edit round 1 score for Ada/ }))
      expect(await bustSwitch()).toBeChecked()

      await user.click(await bustSwitch())
      await user.click(await saveButton())

      const saved = onSaveScore.mock.calls[0][0]
      expect(saved.final_score).toBe(9)
      expect(saved.busted).toBeUndefined()
    })

    it('turning it off on an empty hand leaves a blank row to fill in', async () => {
      const { user } = renderEditor({ roundScores: [BUSTED] })
      await user.click(screen.getByRole('button', { name: /Edit round 1 score for Ada/ }))
      const toggle = await bustSwitch()
      expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()

      await user.click(toggle)

      expect(screen.getByRole('spinbutton', { name: 'Card 1 value' })).toHaveValue(null)
      expect(document.activeElement.tagName).not.toBe('INPUT')
    })

    it('on with no cards shows the bust score, and saves with no cards', async () => {
      const { user, onSaveScore } = renderEditor({ roundScores: [BUSTED] })
      await user.click(screen.getByRole('button', { name: /Edit round 1 score for Ada/ }))

      expect(await screen.findByText('Bust', { selector: 'p' })).toBeInTheDocument()
      await user.click(await saveButton())

      expect(onSaveScore).toHaveBeenCalledWith(expect.objectContaining({ cards: [], final_score: 0, busted: true }))
    })

    it('removing every card still saves a plain 0 with it off', async () => {
      const { user, onSaveScore } = renderEditor()
      await user.click(screen.getByRole('button', { name: 'Edit round 1 score for Ada' }))
      await user.click(await screen.findByRole('button', { name: 'Remove card 1' }))
      await user.click(await saveButton())

      expect(onSaveScore.mock.calls[0][0].busted).toBeUndefined()
    })

    it('a duplicate hand is saved as a bust even with it off', async () => {
      const cards = [{ type: 'number', value: '5' }, { type: 'number', value: '5' }]
      const { user, onSaveScore } = renderEditor({ initialEdit: { player_id: 'p1', round_number: 1, cards } })

      expect(await bustSwitch()).not.toBeChecked()
      await user.click(await saveButton())

      expect(onSaveScore).toHaveBeenCalledWith(expect.objectContaining({ final_score: 0, busted: true }))
    })

    it('opens a late bust from initialEdit with it on', async () => {
      renderEditor({ initialEdit: { player_id: 'p1', round_number: 1, cards: [], busted: true } })

      expect(await bustSwitch()).toBeChecked()
    })
  })

  describe('the Steal or Swap override', () => {
    const DUPLICATE = [{ type: 'number', value: '5' }, { type: 'number', value: '5' }]
    const override = () => screen.queryByRole('switch', { name: 'Came from a Steal or Swap' })
    const vengeanceRoom = { current_round: 3, game_mode: 'vengeance' }

    it('applies to a duplicate in Vengeance: both cards score, and it is saved', async () => {
      const { user, onSaveScore } = renderEditor({
        room: vengeanceRoom,
        initialEdit: { player_id: 'p1', round_number: 1, cards: DUPLICATE },
      })

      await user.click(override())
      await user.click(await saveButton())

      const saved = onSaveScore.mock.calls[0][0]
      expect(saved.final_score).toBe(10)
      expect(saved.duplicate_allowed).toBe(true)
      expect(saved.busted).toBeUndefined()
    })

    it('a stored override opens with it on', async () => {
      const { user } = renderEditor({
        room: vengeanceRoom,
        roundScores: [{ player_id: 'p1', round_number: 1, final_score: 10, duplicate_allowed: true, cards: DUPLICATE }],
      })

      await user.click(screen.getByRole('button', { name: 'Edit round 1 score for Ada' }))

      expect(await screen.findByRole('switch', { name: 'Came from a Steal or Swap' })).toBeChecked()
    })

    it('opens from initialEdit with it on', () => {
      renderEditor({ room: vengeanceRoom, initialEdit: { player_id: 'p1', round_number: 1, cards: DUPLICATE, duplicate_allowed: true } })

      expect(override()).toBeChecked()
    })

    it('Classic never offers it', () => {
      renderEditor({ initialEdit: { player_id: 'p1', round_number: 1, cards: DUPLICATE } })

      expect(override()).not.toBeInTheDocument()
    })

    it('is hidden with Bust on, and with no duplicate', async () => {
      const { user } = renderEditor({
        room: vengeanceRoom,
        initialEdit: { player_id: 'p1', round_number: 1, cards: DUPLICATE },
      })

      await user.click(screen.getByRole('switch', { name: 'Bust' }))

      expect(override()).not.toBeInTheDocument()
    })

    it('Cancel forgets the switches for the next score opened', async () => {
      const { user } = renderEditor({ room: vengeanceRoom, roundScores: [{ player_id: 'p1', round_number: 1, final_score: 0, busted: true, cards: [] }] })
      await user.click(screen.getByRole('button', { name: /Edit round 1 score for Ada/ }))
      await user.click(await screen.findByRole('button', { name: /^cancel$/i }))

      await user.click(await screen.findByRole('button', { name: 'Edit round 3 score for Ada' }))

      expect(await screen.findByRole('switch', { name: 'Bust' })).not.toBeChecked()
    })
  })

  // X19: the preview used the raw cards while Save sent the cards without blank rows.
  it('previews the score of the cards that will be saved, without blank rows', async () => {
    const cards = [
      { type: 'number', value: '5' },
      { type: 'number', value: '8' },
      { type: 'multiplier', value: '' },
    ]
    const { user, onSaveScore } = renderEditor({ initialEdit: { player_id: 'p1', round_number: 1, cards } })

    expect(screen.queryByText('26')).not.toBeInTheDocument()
    expect(screen.getByText('13')).toBeInTheDocument()

    await user.click(await saveButton())
    expect(onSaveScore).toHaveBeenCalledWith(expect.objectContaining({ final_score: 13 }))
  })
})
