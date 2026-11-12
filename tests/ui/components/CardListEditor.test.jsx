import React, { useState } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import CardListEditor from '@/components/game/CardListEditor'
import { CARD_TYPES } from '@/lib/flip7Scoring'

// The editor defaults to Classic, which has no ÷2 or minus card (X57).
const CLASSIC_TYPES = CARD_TYPES.filter((cardType) => !['divisor', 'subtractor'].includes(cardType.value))

function ControlledEditor({ initial }) {
  const [cards, setCards] = useState(initial)
  return <CardListEditor cards={cards} onCardsChange={setCards} />
}

function cardTypes() {
  return screen.getAllByRole('combobox').map((picker) => picker.value)
}

// Focus in a value field is what raises the phone keyboard, so "no keyboard" means no input focused.
function expectNoInputFocused() {
  expect(document.activeElement.tagName).not.toBe('INPUT')
}

describe('CardListEditor', () => {
  it('offers the card types of the mode in the type picker', () => {
    render(<ControlledEditor initial={[{ type: 'number', value: '' }]} />)

    const picker = screen.getByRole('combobox', { name: 'Card 1 type' })
    const labels = Array.from(picker.options).map((option) => option.textContent)

    expect(labels).toEqual(CLASSIC_TYPES.map((cardType) => cardType.label))
  })

  it('lets each card type be picked', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[{ type: 'number', value: '' }]} />)
    const picker = screen.getByRole('combobox', { name: 'Card 1 type' })

    for (const cardType of CLASSIC_TYPES) {
      await user.selectOptions(picker, cardType.value)
      expect(picker).toHaveValue(cardType.value)
    }
  })

  it('edits and removes cards', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[{ type: 'number', value: '3' }, { type: 'number', value: '4' }]} />)

    await user.type(screen.getByRole('spinbutton', { name: 'Card 1 value' }), '5')
    expect(screen.getByRole('spinbutton', { name: 'Card 1 value' })).toHaveValue(35)

    await user.click(screen.getByRole('button', { name: 'Remove card 1' }))
    expect(screen.getAllByRole('spinbutton')).toHaveLength(1)
    expect(screen.getByRole('spinbutton', { name: 'Card 1 value' })).toHaveValue(4)
  })

  // X34: a number field brings up the number keyboard on phones.
  it('uses a number field for every card type', () => {
    const initial = CARD_TYPES.map((cardType) => ({ type: cardType.value, value: '2' }))
    render(<ControlledEditor initial={initial} />)

    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    expect(screen.getAllByRole('spinbutton')).toHaveLength(CARD_TYPES.length)
  })

  it('drops the sign from a modifier value as it is typed (X34)', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[{ type: 'subtractor', value: '' }]} />)
    const input = screen.getByRole('spinbutton', { name: 'Card 1 value' })

    await user.type(input, '-4')

    expect(input).toHaveValue(4)
  })

  it('drops the sign when a negative number row becomes a modifier (X34)', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[{ type: 'number', value: '-6' }]} />)

    await user.selectOptions(screen.getByRole('combobox', { name: 'Card 1 type' }), 'adder')

    expect(screen.getByRole('spinbutton', { name: 'Card 1 value' })).toHaveValue(6)
  })

  it('adds a card of the same type when Enter is pressed', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[{ type: 'adder', value: '' }]} />)

    await user.type(screen.getByRole('spinbutton', { name: 'Card 1 value' }), '2{Enter}')

    expect(cardTypes()).toEqual(['adder', 'adder'])
    expect(screen.getByRole('spinbutton', { name: 'Card 2 value' })).toHaveFocus()
  })

  // --- Add card and the type switch ---

  it('adds a number card, then switches it to each type', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[{ type: 'number', value: '1' }]} />)

    await user.click(screen.getByRole('button', { name: 'Add card' }))
    expect(cardTypes()).toEqual(['number', 'number'])

    const switcher = within(screen.getByRole('group', { name: 'Switch card 2 to' }))
    const steps = [['Multiply', 'multiplier'], ['Plus', 'adder'], ['Number', 'number']]
    for (const [buttonName, type] of steps) {
      await user.click(switcher.getByRole('button', { name: buttonName }))
      expect(cardTypes()).toEqual(['number', type])
      expect(switcher.getByRole('button', { name: buttonName })).toHaveAttribute('aria-pressed', 'true')
    }
  })

  it('switches the newest card when no row has been focused, and keeps its value', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[{ type: 'number', value: '3' }, { type: 'number', value: '4' }]} />)

    await user.click(screen.getByRole('button', { name: 'Plus' }))

    expect(cardTypes()).toEqual(['number', 'adder'])
    expect(screen.getByRole('spinbutton', { name: 'Card 2 value' })).toHaveValue(4)
  })

  it('switches the row with the text cursor, not the newest', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[{ type: 'number', value: '3' }, { type: 'number', value: '4' }]} />)

    await user.click(screen.getByRole('spinbutton', { name: 'Card 1 value' }))
    expect(screen.getByRole('group', { name: 'Switch card 1 to' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Plus' }))

    expect(cardTypes()).toEqual(['adder', 'number'])
  })

  it('a new card becomes the row the type buttons act on', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[{ type: 'number', value: '3' }]} />)

    await user.click(screen.getByRole('spinbutton', { name: 'Card 1 value' }))
    await user.click(screen.getByRole('button', { name: 'Add card' }))
    await user.click(screen.getByRole('button', { name: 'Plus' }))

    expect(cardTypes()).toEqual(['number', 'adder'])
  })

  it('goes back to the newest row when the focused one is removed', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[{ type: 'number', value: '1' }, { type: 'number', value: '2' }, { type: 'number', value: '3' }]} />)

    await user.click(screen.getByRole('spinbutton', { name: 'Card 1 value' }))
    await user.click(screen.getByRole('button', { name: 'Remove card 1' }))

    expect(screen.getByRole('group', { name: 'Switch card 2 to' })).toBeInTheDocument()
  })

  // --- Add card taps ---

  it('adds a row for each separate tap, even onto blank rows', async () => {
    const now = vi.spyOn(Date, 'now')
    const user = userEvent.setup()
    render(<ControlledEditor initial={[{ type: 'number', value: '' }]} />)

    for (const time of [1000, 2000, 3000]) {
      now.mockReturnValue(time)
      await user.click(screen.getByRole('button', { name: 'Add card' }))
    }

    expect(cardTypes()).toHaveLength(4)
    now.mockRestore()
  })

  it('counts a double tap as one, while the new row is still blank', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const user = userEvent.setup()
    render(<ControlledEditor initial={[{ type: 'number', value: '3' }]} />)

    await user.click(screen.getByRole('button', { name: 'Add card' }))
    now.mockReturnValue(1100)
    await user.click(screen.getByRole('button', { name: 'Add card' }))

    expect(cardTypes()).toHaveLength(2)
    now.mockRestore()
  })

  it('does not treat a quick tap as a double tap once the new row has a value', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const user = userEvent.setup()
    render(<ControlledEditor initial={[{ type: 'number', value: '3' }]} />)

    await user.click(screen.getByRole('button', { name: 'Add card' }))
    await user.type(screen.getByRole('spinbutton', { name: 'Card 2 value' }), '5')
    now.mockReturnValue(1100)
    await user.click(screen.getByRole('button', { name: 'Add card' }))

    expect(cardTypes()).toHaveLength(3)
    now.mockRestore()
  })

  it('has no type switch until there is a card, and Add card adds the first', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[]} />)
    expect(screen.queryByRole('button', { name: 'Plus' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add card' }))

    expect(cardTypes()).toEqual(['number'])
    expect(screen.getByRole('button', { name: 'Plus' })).toBeInTheDocument()
  })

  it('colours a value field\'s border to match its type picker', () => {
    render(<ControlledEditor initial={[{ type: 'number', value: '1' }, { type: 'subtractor', value: '2' }]} />)

    expect(screen.getByRole('combobox', { name: 'Card 1 type' })).toHaveClass('border-blue-300')
    expect(screen.getByRole('spinbutton', { name: 'Card 1 value' })).toHaveClass('border-blue-300')
    expect(screen.getByRole('combobox', { name: 'Card 2 type' })).toHaveClass('border-red-300')
    expect(screen.getByRole('spinbutton', { name: 'Card 2 value' })).toHaveClass('border-red-300')
  })

  it('focuses a blank row when it is switched, ready for its value (X39)', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[{ type: 'number', value: '' }]} />)

    await user.click(screen.getByRole('button', { name: 'Plus' }))

    expect(screen.getByRole('spinbutton', { name: 'Card 1 value' })).toHaveFocus()
  })

  it('does not focus a row that already has its value when it is switched (X39)', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[{ type: 'number', value: '4' }]} />)

    await user.click(screen.getByRole('button', { name: 'Plus' }))

    expectNoInputFocused()
  })

  // --- Focus: only an add moves it (X39) ---

  it('does not focus a value field when it opens with cards (X39)', () => {
    render(<ControlledEditor initial={[{ type: 'number', value: '3' }, { type: 'number', value: '4' }]} />)

    expectNoInputFocused()
  })

  it('does not focus a value field when it opens under StrictMode (X39)', () => {
    render(
      <React.StrictMode>
        <ControlledEditor initial={[{ type: 'number', value: '3' }, { type: 'number', value: '4' }]} />
      </React.StrictMode>,
    )

    expectNoInputFocused()
  })

  it('does not focus a value field when a card is removed (X39)', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[{ type: 'number', value: '3' }, { type: 'number', value: '4' }]} />)

    await user.click(screen.getByRole('button', { name: 'Remove card 1' }))

    expect(screen.getAllByRole('spinbutton')).toHaveLength(1)
    expectNoInputFocused()
  })

  it('does not focus a value field when the cards are replaced from outside (X39)', () => {
    const { rerender } = render(<CardListEditor cards={[{ type: 'number', value: '3' }]} onCardsChange={() => {}} />)

    rerender(<CardListEditor cards={[{ type: 'number', value: '3' }, { type: 'number', value: '5' }]} onCardsChange={() => {}} />)

    expectNoInputFocused()
  })

  it('focuses the new row when Add card adds a card (X39)', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[{ type: 'number', value: '3' }]} />)

    await user.click(screen.getByRole('button', { name: 'Add card' }))

    expect(screen.getByRole('spinbutton', { name: 'Card 2 value' })).toHaveFocus()
  })

  it('scrolls Add card back into view after it adds a card', async () => {
    const user = userEvent.setup()
    render(
      <div data-testid="scroller" style={{ overflowY: 'auto' }}>
        <ControlledEditor initial={[{ type: 'number', value: '3' }]} />
      </div>,
    )
    const addButton = screen.getByRole('button', { name: 'Add card' })
    addButton.getBoundingClientRect = () => ({ top: window.innerHeight + 60, bottom: window.innerHeight + 100 })

    await user.click(addButton)

    await waitFor(() => expect(screen.getByTestId('scroller').scrollTop).toBeGreaterThanOrEqual(100))
  })

  it('focuses the first row when Add card adds to an empty list (X39)', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[]} />)

    await user.click(screen.getByRole('button', { name: 'Add card' }))

    expect(screen.getByRole('spinbutton', { name: 'Card 1 value' })).toHaveFocus()
  })

  it('focuses the row Enter adds even after a card was removed (X39)', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={[{ type: 'number', value: '3' }, { type: 'number', value: '4' }]} />)
    await user.click(screen.getByRole('button', { name: 'Remove card 2' }))

    await user.type(screen.getByRole('spinbutton', { name: 'Card 1 value' }), '{Enter}')

    expect(screen.getByRole('spinbutton', { name: 'Card 2 value' })).toHaveFocus()
  })
})
