import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import ManualScoreEntry from '@/components/game/ManualScoreEntry'

function renderEntry(props = {}) {
  const onScoreConfirmed = vi.fn()
  const onCancel = vi.fn()
  render(<ManualScoreEntry onScoreConfirmed={onScoreConfirmed} onCancel={onCancel} {...props} />)
  return { onScoreConfirmed, onCancel, user: userEvent.setup() }
}

function numberCards(count) {
  return Array.from({ length: count }, (_, index) => ({ type: 'number', value: String(index) }))
}

const confirmButton = () => screen.getByRole('button', { name: /confirm score|submitting/i })

describe('ManualScoreEntry', () => {
  it('updates the score live as cards are added, edited and removed', async () => {
    const { user } = renderEntry()

    await user.type(screen.getByRole('spinbutton', { name: 'Card 1 value' }), '5')
    expect(screen.getByText('Total:')).toBeInTheDocument()
    expect(screen.getByText('5', { selector: 'p' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add card' }))
    await user.type(screen.getByRole('spinbutton', { name: 'Card 2 value' }), '7')
    expect(screen.getByText('12', { selector: 'p' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Remove card 1' }))
    expect(screen.getByText('7', { selector: 'p' })).toBeInTheDocument()
  })

  it('adds a modifier row of the chosen type that counts toward the score', async () => {
    const { user } = renderEntry({ initialCards: [{ type: 'number', value: '5' }] })

    await user.click(screen.getByRole('button', { name: 'Add card' }))
    await user.click(screen.getByRole('button', { name: 'Multiply' }))

    expect(screen.getByRole('combobox', { name: 'Card 2 type' })).toHaveValue('multiplier')
    await user.type(screen.getByRole('spinbutton', { name: 'Card 2 value' }), '2')
    expect(screen.getByText('10', { selector: 'p' })).toBeInTheDocument()
  })

  it('shows a bust for a duplicate number', () => {
    renderEntry({ initialCards: [{ type: 'number', value: '4' }, { type: 'number', value: '4' }] })

    expect(screen.getByText('Duplicate Cards')).toBeInTheDocument()
    expect(screen.getByText('0', { selector: 'p' })).toBeInTheDocument()
  })

  it('confirms with cards, baseSum and finalScore', async () => {
    const cards = [{ type: 'number', value: '5' }, { type: 'number', value: '7' }]
    const { user, onScoreConfirmed } = renderEntry({ initialCards: cards })

    await user.click(confirmButton())

    expect(onScoreConfirmed).toHaveBeenCalledTimes(1)
    expect(onScoreConfirmed).toHaveBeenCalledWith(expect.objectContaining({ cards, baseSum: 12, finalScore: 12 }))
  })

  it('disables confirm while submitting', () => {
    renderEntry({ initialCards: numberCards(2), isSubmitting: true })

    expect(confirmButton()).toBeDisabled()
    expect(confirmButton()).toHaveTextContent('Submitting')
  })

  it('shows restored initialCards, with modifier signs stripped (X34)', () => {
    renderEntry({ initialCards: [{ type: 'number', value: '9' }, { type: 'adder', value: '+2' }] })

    expect(screen.getByRole('spinbutton', { name: 'Card 1 value' })).toHaveValue(9)
    expect(screen.getByRole('spinbutton', { name: 'Card 2 value' })).toHaveValue(2)
  })

  it('a type button switches the blank starting row (X34)', async () => {
    const onCardsChange = vi.fn()
    const { user } = renderEntry({ onCardsChange })

    await user.click(screen.getByRole('button', { name: 'Plus' }))

    expect(onCardsChange).toHaveBeenLastCalledWith([{ type: 'adder', value: '' }])
  })

  // X39: the manual screen is opened to be typed in, so it keeps focus-on-open.
  it('focuses the first value field when it opens (X39)', () => {
    renderEntry()

    expect(screen.getByRole('spinbutton', { name: 'Card 1 value' })).toHaveFocus()
  })

  // X56: the panel scrolls itself to the top on open, and the browser's scroll to the field would fight it.
  it('leaves the scrolling to the panel when it focuses the field on open (X56)', () => {
    const focus = vi.spyOn(HTMLInputElement.prototype, 'focus')

    renderEntry()

    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    focus.mockRestore()
  })

  it('starts with one empty row when nothing is restored', () => {
    renderEntry()

    expect(screen.getAllByRole('spinbutton')).toHaveLength(1)
    expect(screen.getByRole('spinbutton', { name: 'Card 1 value' })).toHaveValue(null)
  })

  it('reports every change through onCardsChange', async () => {
    const onCardsChange = vi.fn()
    const { user } = renderEntry({ onCardsChange })

    await user.type(screen.getByRole('spinbutton', { name: 'Card 1 value' }), '3')
    expect(onCardsChange).toHaveBeenLastCalledWith([{ type: 'number', value: '3' }])

    await user.click(screen.getByRole('button', { name: 'Add card' }))
    expect(onCardsChange).toHaveBeenLastCalledWith([
      { type: 'number', value: '3' },
      { type: 'number', value: '' },
    ])

    await user.click(screen.getByRole('button', { name: 'Remove card 2' }))
    expect(onCardsChange).toHaveBeenLastCalledWith([{ type: 'number', value: '3' }])
  })

  it('calls onCancel from Back', async () => {
    const { user, onCancel } = renderEntry()

    await user.click(screen.getByRole('button', { name: 'Back' }))

    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('ignores blank rows in the score and does not send them (X2)', async () => {
    const cards = [
      { type: 'number', value: '5' },
      { type: 'number', value: '' },
      { type: 'multiplier', value: '' },
      { type: 'divisor', value: ' ' },
      { type: 'adder', value: '' },
      { type: 'subtractor', value: '' },
    ]
    const { user, onScoreConfirmed } = renderEntry({ initialCards: cards })

    expect(screen.getByText('5', { selector: 'p' })).toBeInTheDocument()
    await user.click(confirmButton())

    const sent = onScoreConfirmed.mock.calls[0][0]
    expect(sent.cards).toEqual([{ type: 'number', value: '5' }])
    expect(sent.finalScore).toBe(5)
  })

  it('does not bust a real 0 card because of a blank row', async () => {
    const { user, onScoreConfirmed } = renderEntry({
      initialCards: [{ type: 'number', value: '' }, { type: 'number', value: '0' }, { type: 'number', value: '3' }],
    })

    await user.click(confirmButton())

    expect(onScoreConfirmed.mock.calls[0][0]).toEqual(
      expect.objectContaining({ cards: [{ type: 'number', value: '0' }, { type: 'number', value: '3' }], finalScore: 3 }),
    )
  })

  it('does not give the 7-card bonus for six cards plus a blank row', async () => {
    const { user, onScoreConfirmed } = renderEntry({
      initialCards: [...numberCards(6), { type: 'number', value: '' }],
    })

    await user.click(confirmButton())

    expect(onScoreConfirmed.mock.calls[0][0].bonus).toBe(0)
  })

  it('sends a negative total as it is, without flooring at 0 (X1)', async () => {
    const { user, onScoreConfirmed } = renderEntry({
      initialCards: [{ type: 'number', value: '2' }, { type: 'subtractor', value: '4' }],
    })

    expect(screen.getByText('−2', { selector: 'p' })).toBeInTheDocument()
    await user.click(confirmButton())

    expect(onScoreConfirmed).toHaveBeenCalledWith(expect.objectContaining({ finalScore: -2 }))
  })

  it('sends a negative number card as a negative baseSum', async () => {
    const { user, onScoreConfirmed } = renderEntry({ initialCards: [{ type: 'number', value: '-3' }] })

    await user.click(confirmButton())

    expect(onScoreConfirmed).toHaveBeenCalledWith(expect.objectContaining({ baseSum: -3, finalScore: -3 }))
  })

  it('allows exactly 30 cards', async () => {
    const { user, onScoreConfirmed } = renderEntry({ initialCards: numberCards(30) })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await user.click(confirmButton())

    expect(onScoreConfirmed).toHaveBeenCalledTimes(1)
  })

  it('blocks and explains more than 30 cards', async () => {
    const { user, onScoreConfirmed } = renderEntry({ initialCards: numberCards(31) })

    expect(screen.getByRole('alert')).toHaveTextContent('at most 30 cards')
    expect(confirmButton()).toBeDisabled()
    await user.click(confirmButton())
    expect(onScoreConfirmed).not.toHaveBeenCalled()
  })

  it('does not count blank rows toward the 30-card limit', () => {
    renderEntry({ initialCards: [...numberCards(30), { type: 'number', value: '' }] })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(confirmButton()).toBeEnabled()
  })

  it('disables confirm when only blank rows remain', () => {
    renderEntry()

    expect(confirmButton()).toBeDisabled()
  })
})
