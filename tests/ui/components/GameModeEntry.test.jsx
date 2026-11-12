// Card entry under a game mode (X41, X42): the add buttons, special rows, misread fixes and
// re-scoring, on all three screens that score a hand.
import React, { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SoundProvider } from '@/components/useSound'
import CardListEditor from '@/components/game/CardListEditor'
import CardScanner from '@/components/game/CardScanner'
import ManualScoreEntry from '@/components/game/ManualScoreEntry'
import ScoreEditor from '@/components/game/ScoreEditor'

vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

const LUCKY_13 = { type: 'special', value: '13' }
const UNLUCKY_7 = { type: 'special', value: '7' }
const ZERO = { type: 'special', value: '0' }

function number(value) {
  return { type: 'number', value: String(value) }
}

function minus(value) {
  return { type: 'subtractor', value: String(value) }
}

function ControlledEditor({ initial, gameMode = 'vengeance' }) {
  const [cards, setCards] = useState(initial)
  return (
    <>
      <CardListEditor cards={cards} onCardsChange={setCards} gameMode={gameMode} />
      <output aria-label="cards">{JSON.stringify(cards)}</output>
    </>
  )
}

function currentCards() {
  return JSON.parse(screen.getByLabelText('cards').textContent)
}

function expectNoInputFocused() {
  expect(document.activeElement.tagName).not.toBe('INPUT')
}

function renderManual(props = {}) {
  const onScoreConfirmed = vi.fn()
  const view = render(
    <ManualScoreEntry gameMode="vengeance" onScoreConfirmed={onScoreConfirmed} onCancel={vi.fn()} {...props} />,
  )
  return { onScoreConfirmed, user: userEvent.setup(), ...view }
}

function renderScanner(props = {}) {
  const onCardsConfirmed = vi.fn()
  render(
    <SoundProvider>
      <CardScanner
        gameMode="vengeance"
        onCardsConfirmed={onCardsConfirmed}
        onCancel={vi.fn()}
        onManualEntry={vi.fn()}
        aiEnabled={true}
        modelList={[]}
        setCurrentModel={vi.fn()}
        {...props}
      />
    </SoundProvider>,
  )
  return { onCardsConfirmed, user: userEvent.setup() }
}

function renderEditor({ room = {}, cards = [number(5), minus(10)] } = {}) {
  const onSaveScore = vi.fn().mockResolvedValue({ ok: true })
  render(
    <ScoreEditor
      players={[{ id: 'p1', name: 'Ada', total_score: 0 }]}
      roundScores={[]}
      room={{ current_round: 1, game_mode: 'vengeance', ...room }}
      initialEdit={{ player_id: 'p1', round_number: 1, cards }}
      onSaveScore={onSaveScore}
      onClose={vi.fn()}
      isSaving={false}
      isClosing={false}
    />,
  )
  return { onSaveScore, user: userEvent.setup() }
}

const finalScoreShown = (value) => screen.getByText(String(value), { selector: 'p' })

// --- Type switch ---------------------------------------------------------------

describe('CardListEditor: type switch per mode', () => {
  it('Classic has only its base game types and no special cards (X57)', () => {
    render(<ControlledEditor initial={[number('')]} gameMode="classic" />)

    for (const name of ['Number', 'Multiply', 'Plus']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
    expect(screen.queryByRole('button', { name: 'Lucky 13' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Divide' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Minus' })).not.toBeInTheDocument()
  })

  it('a missing or unknown mode reads as Classic', () => {
    render(<ControlledEditor initial={[number('')]} gameMode="not-a-mode" />)

    expect(screen.getByRole('button', { name: 'Plus' })).toBeInTheDocument()
  })

  it('Vengeance offers ÷2, −N, numbers and the three special cards, and no x2 or +N', () => {
    render(<ControlledEditor initial={[number('')]} />)

    for (const name of ['Number', 'Divide', 'Minus', 'The Zero', 'Unlucky 7', 'Lucky 13']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
    expect(screen.queryByRole('button', { name: 'Multiply' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Plus' })).not.toBeInTheDocument()
  })

  it('a special button switches the newest card and focuses nothing, so no keyboard opens', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[number(3), number('')]} />)

    await user.click(screen.getByRole('button', { name: 'Lucky 13' }))

    expect(currentCards()).toEqual([number(3), LUCKY_13])
    expectNoInputFocused()
  })

  it('a special button adds a new row when the row it would change has a value', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[number(3)]} />)

    await user.click(screen.getByRole('button', { name: 'Lucky 13' }))

    expect(currentCards()).toEqual([number(3), LUCKY_13])
    expectNoInputFocused()
  })

  it('tapping the type a special row already is changes nothing', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[LUCKY_13]} />)

    await user.click(screen.getByRole('button', { name: 'Lucky 13' }))

    expect(currentCards()).toEqual([LUCKY_13])
  })

  it('a special button can switch the only row', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[number('')]} />)

    await user.click(screen.getByRole('button', { name: 'The Zero' }))

    expect(currentCards()).toEqual([ZERO])
  })

  it('allows one of each special card through its button', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[LUCKY_13, number('')]} />)

    expect(screen.getByRole('button', { name: 'Lucky 13' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Unlucky 7' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Unlucky 7' }))

    expect(screen.getByRole('button', { name: 'Unlucky 7' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Unlucky 7' })).toHaveAttribute('aria-pressed', 'true')
  })
})

// --- Rows ------------------------------------------------------------------------

describe('CardListEditor: rows', () => {
  it('tints only the row of a card past the seventh, and The Zero counts', () => {
    const seven = [ZERO, ...[1, 2, 3, 4, 5, 6].map(number)]
    render(<ControlledEditor initial={[...seven, number(9)]} />)

    const rowOf = (card) => screen.getByRole('button', { name: `Remove card ${card}` }).parentElement
    expect(rowOf(7)).not.toHaveClass('bg-red-100')
    expect(rowOf(8)).toHaveClass('bg-red-100')
  })

  it('a special row has a fixed label and no input', () => {
    render(<ControlledEditor initial={[LUCKY_13]} />)

    expect(screen.getByText('Lucky 13', { selector: 'span' })).toBeInTheDocument()
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove card 1' })).toBeInTheDocument()
  })

  it('a typed 0 becomes The Zero in Vengeance when the field loses focus', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[number('')]} />)

    await user.type(screen.getByRole('spinbutton', { name: 'Card 1 value' }), '0')
    expect(currentCards()).toEqual([number(0)])

    await user.tab()

    expect(currentCards()).toEqual([ZERO])
  })

  // Converting on each keystroke unmounted the input, which closes the phone's keyboard.
  it('deleting the 1 from a typed 10 keeps the field and its focus', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[number('')]} />)
    const input = screen.getByRole('spinbutton', { name: 'Card 1 value' })

    await user.type(input, '10')
    fireEvent.change(input, { target: { value: '0' } })

    expect(currentCards()).toEqual([number(0)])
    expect(screen.getByRole('spinbutton', { name: 'Card 1 value' })).toHaveFocus()
  })

  it('Enter converts a typed 0 before adding the next row', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[number('')]} />)

    await user.type(screen.getByRole('spinbutton', { name: 'Card 1 value' }), '0{Enter}')

    expect(currentCards()).toEqual([ZERO, number('')])
  })

  it('leaving a field with any other value changes nothing', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[number('')]} />)

    await user.type(screen.getByRole('spinbutton', { name: 'Card 1 value' }), '5')
    await user.tab()

    expect(currentCards()).toEqual([number(5)])
  })

  it('a typed 0 stays a number in Classic', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[number('')]} gameMode="classic" />)

    await user.type(screen.getByRole('spinbutton', { name: 'Card 1 value' }), '0')

    expect(currentCards()).toEqual([number(0)])
  })

  it('the picker can turn a plain 13 into Lucky 13 and back', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[number(13)]} />)
    const picker = screen.getByRole('combobox', { name: 'Card 1 type' })

    await user.selectOptions(picker, 'special:13')
    expect(currentCards()).toEqual([LUCKY_13])

    await user.selectOptions(picker, 'number')
    expect(currentCards()).toEqual([number(13)])
  })

  it('the picker still adds a second special, for two decks', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[LUCKY_13, number('')]} />)

    await user.selectOptions(screen.getByRole('combobox', { name: 'Card 2 type' }), 'special:13')

    expect(currentCards()).toEqual([LUCKY_13, LUCKY_13])
  })

  it('a restored row the mode has no button for stays and can be edited', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[{ type: 'multiplier', value: '2' }]} />)

    expect(screen.getByRole('combobox', { name: 'Card 1 type' })).toHaveValue('multiplier')
    await user.type(screen.getByRole('spinbutton', { name: 'Card 1 value' }), '2')

    expect(currentCards()).toEqual([{ type: 'multiplier', value: '22' }])
  })

  it('a special card kept from Vengeance stays visible and labelled in Classic', () => {
    render(<ControlledEditor initial={[LUCKY_13]} gameMode="classic" />)

    expect(screen.getByRole('combobox', { name: 'Card 1 type' })).toHaveValue('special:13')
    expect(screen.getByText('Lucky 13', { selector: 'span' })).toBeInTheDocument()
  })
})

// --- Manual entry ----------------------------------------------------------------

describe('ManualScoreEntry under a mode', () => {
  it('scores the preview and the confirm with the mode', async () => {
    const { onScoreConfirmed, user } = renderManual({ initialCards: [number(5), minus(10)] })

    expect(screen.getByText('5 − 10, floored at 0 =')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /confirm score/i }))

    expect(onScoreConfirmed).toHaveBeenCalledWith(expect.objectContaining({ finalScore: 0, flooredAtZero: true }))
  })

  // iOS Safari doesn't focus a tapped button, so the field may never blur before Confirm.
  it('Confirm sends a typed 0 as The Zero even if the field never lost focus', () => {
    const { onScoreConfirmed } = renderManual({ initialCards: [number(5)] })
    const input = screen.getByRole('spinbutton', { name: 'Card 1 value' })
    fireEvent.change(input, { target: { value: '0' } })

    fireEvent.click(screen.getByRole('button', { name: /confirm score/i }))

    expect(onScoreConfirmed).toHaveBeenCalledWith(expect.objectContaining({ cards: [ZERO], finalScore: 0, zeroed: true }))
  })

  it('re-scores the same cards when the mode changes, keeping them', () => {
    const cards = [number(5), minus(10)]
    const onScoreConfirmed = vi.fn()
    const onCancel = vi.fn()
    const { rerender } = render(
      <ManualScoreEntry gameMode="classic" initialCards={cards} onScoreConfirmed={onScoreConfirmed} onCancel={onCancel} />,
    )
    expect(finalScoreShown('−5')).toBeInTheDocument()
    const firstInput = screen.getByRole('spinbutton', { name: 'Card 1 value' })

    rerender(
      <ManualScoreEntry gameMode="vengeance" initialCards={cards} onScoreConfirmed={onScoreConfirmed} onCancel={onCancel} />,
    )

    expect(finalScoreShown(0)).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Card 1 value' })).toBe(firstInput)
  })

  it('shows the reminder only in a mode that has one', () => {
    const reminder = 'Score once the round ends, cards aren\'t safe until then.'
    const { unmount } = renderManual()
    expect(screen.getByText(reminder)).toBeInTheDocument()
    unmount()

    renderManual({ gameMode: 'classic' })
    expect(screen.queryByText(reminder)).not.toBeInTheDocument()
  })

  it('warns about more than seven number cards', () => {
    renderManual({ initialCards: [1, 2, 3, 4, 5, 6, 8, 9].map(number) })

    expect(screen.getByText('More than 7 number cards, so no bonus. Check your cards.')).toBeInTheDocument()
  })

  it('a bust on two 13s offers the Lucky 13 fix, and one tap undoes the bust', async () => {
    const onCardsChange = vi.fn()
    const { user } = renderManual({ initialCards: [number(13), number(13)], onCardsChange })
    expect(screen.getByText('Duplicate Cards')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Change one 13 to Lucky 13' }))

    expect(screen.queryByText('Duplicate Cards')).not.toBeInTheDocument()
    expect(finalScoreShown(26)).toBeInTheDocument()
    expect(onCardsChange).toHaveBeenLastCalledWith([LUCKY_13, number(13)])
    expectNoInputFocused()
  })

  it('after a fix, focus stays in the panel and the change is announced politely', async () => {
    const { user } = renderManual({ initialCards: [number(13), number(13)] })

    await user.click(screen.getByRole('button', { name: 'Change one 13 to Lucky 13' }))

    expect(document.activeElement).not.toBe(document.body)
    expect(screen.getByRole('status')).toHaveTextContent('Changed one 13 to Lucky 13.')
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
  })

  it('the announcement goes once the cards change again', async () => {
    const { user } = renderManual({ initialCards: [number(13), number(13)] })
    await user.click(screen.getByRole('button', { name: 'Change one 13 to Lucky 13' }))

    await user.click(screen.getByRole('button', { name: 'Remove card 2' }))

    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('the live region is there before a fix, as screen readers only announce changes in one they know', () => {
    renderManual({ initialCards: [number(5)] })

    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('a bust on two 7s offers the Unlucky 7 fix, then explains why it still busts', async () => {
    const { user } = renderManual({ initialCards: [number(7), number(7)] })

    await user.click(screen.getByRole('button', { name: 'Change one 7 to Unlucky 7' }))

    expect(screen.getByText('Duplicate Cards')).toBeInTheDocument()
    expect(screen.getByText('A 7 flipped after the Unlucky 7 is still a duplicate, so this hand busts.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change one 7 to Unlucky 7' })).not.toBeInTheDocument()
  })

  it('Classic offers no fix for two 13s', () => {
    renderManual({ gameMode: 'classic', initialCards: [number(13), number(13)] })

    expect(screen.getByText('Duplicate Cards')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^change one/i })).not.toBeInTheDocument()
  })

  describe('the Steal or Swap override (X45)', () => {
    const override = () => screen.queryByRole('switch', { name: 'Came from a Steal or Swap' })

    it('turning it on undoes the bust, and the score says so', async () => {
      const { onScoreConfirmed, user } = renderManual({ initialCards: [number(5), number(5)] })
      expect(screen.getByText('Duplicate Cards')).toBeInTheDocument()

      await user.click(override())

      expect(screen.queryByText('Duplicate Cards')).not.toBeInTheDocument()
      expect(finalScoreShown(10)).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: /confirm score/i }))
      expect(onScoreConfirmed).toHaveBeenCalledWith(expect.objectContaining({ finalScore: 10, duplicateAllowed: true }))
    })

    it('stays on screen while on, so it can be turned off', async () => {
      const { user } = renderManual({ initialCards: [number(5), number(5)] })

      await user.click(override())
      await user.click(override())

      expect(screen.getByText('Duplicate Cards')).toBeInTheDocument()
    })

    it('tells the draft when it changes', async () => {
      const onDuplicateAllowedChange = vi.fn()
      const { user } = renderManual({ initialCards: [number(5), number(5)], onDuplicateAllowedChange })

      await user.click(override())

      expect(onDuplicateAllowedChange).toHaveBeenCalledWith(true)
    })

    it('comes back on from a restored draft', () => {
      renderManual({ initialCards: [number(5), number(5)], initialDuplicateAllowed: true })

      expect(override()).toBeChecked()
      expect(finalScoreShown(10)).toBeInTheDocument()
    })

    it('is not offered without a duplicate', () => {
      renderManual({ initialCards: [number(5), number(6)] })

      expect(override()).not.toBeInTheDocument()
    })

    it('is not offered in Classic', () => {
      renderManual({ gameMode: 'classic', initialCards: [number(5), number(5)] })

      expect(override()).not.toBeInTheDocument()
    })

    it('works in the scanner too', async () => {
      const { onCardsConfirmed, user } = renderScanner({ initialCards: [number(5), number(5)] })

      await user.click(override())
      await user.click(screen.getByRole('button', { name: /confirm score/i }))

      expect(onCardsConfirmed).toHaveBeenCalledWith(expect.objectContaining({ finalScore: 10, duplicateAllowed: true }))
    })

    it('retaking the photo forgets it, as the next photo is a new hand', async () => {
      const onDuplicateAllowedChange = vi.fn()
      const { user } = renderScanner({
        initialCards: [number(5), number(5)],
        initialDuplicateAllowed: true,
        onDuplicateAllowedChange,
      })

      await user.click(screen.getByRole('button', { name: /retake photo/i }))

      expect(onDuplicateAllowedChange).toHaveBeenLastCalledWith(false)
    })

    it('a duplicate bust is confirmed with its cards', async () => {
      const { onScoreConfirmed, user } = renderManual({ initialCards: [number(5), number(5)] })

      await user.click(screen.getByRole('button', { name: /confirm score/i }))

      expect(onScoreConfirmed).toHaveBeenCalledWith(expect.objectContaining({
        cards: [number(5), number(5)],
        isBust: true,
        finalScore: 0,
      }))
    })
  })

  it('Unlucky 7 with other cards scores them all and shows the quiet reminder', () => {
    renderManual({ initialCards: [UNLUCKY_7, number(5), minus(2)] })

    expect(finalScoreShown(10)).toBeInTheDocument()
    expect(screen.getByText('Unlucky 7 discards the cards you had before it.')).toBeInTheDocument()
  })
})

// --- Scanner -------------------------------------------------------------------

describe('CardScanner under a mode', () => {
  it('scores restored cards with the mode and applies the mode to them', async () => {
    const { onCardsConfirmed, user } = renderScanner({ initialCards: [number(0), number(12)] })

    expect(screen.getByText('The Zero scores 0 without a Flip 7:')).toBeInTheDocument()
    expect(screen.getByText('The Zero', { selector: 'span' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /confirm score/i }))
    expect(onCardsConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({ cards: [ZERO, number(12)], finalScore: 0, zeroed: true }),
    )
  })

  it('the bust fix works here too', async () => {
    const { user } = renderScanner({ initialCards: [number(13), number(13)] })

    await user.click(screen.getByRole('button', { name: 'Change one 13 to Lucky 13' }))

    expect(finalScoreShown(26)).toBeInTheDocument()
  })

  it('shows the reminder', () => {
    renderScanner()

    expect(screen.getByText('Score once the round ends, cards aren\'t safe until then.')).toBeInTheDocument()
  })
})

// --- Score editor ----------------------------------------------------------------

describe('ScoreEditor under a mode', () => {
  it('scores with the room\'s mode and sends it with the score', async () => {
    const { onSaveScore, user } = renderEditor()

    expect(finalScoreShown(0)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    expect(onSaveScore).toHaveBeenCalledWith(expect.objectContaining({ final_score: 0, game_mode: 'vengeance' }))
  })

  it('a room with no mode scores as Classic', async () => {
    const { onSaveScore, user } = renderEditor({ room: { game_mode: undefined } })

    await user.click(screen.getByRole('button', { name: /^save$/i }))

    expect(onSaveScore).toHaveBeenCalledWith(expect.objectContaining({ final_score: -5, game_mode: 'classic' }))
  })

  it('offers the fix and shows the special row', async () => {
    const { user } = renderEditor({ cards: [number(13), number(13)] })

    await user.click(screen.getByRole('button', { name: 'Change one 13 to Lucky 13' }))

    expect(screen.getByText('Lucky 13', { selector: 'span' })).toBeInTheDocument()
    expect(finalScoreShown(26)).toBeInTheDocument()
  })
})
