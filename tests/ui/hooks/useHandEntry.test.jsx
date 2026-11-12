import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useHandEntry } from '@/hooks/useHandEntry'

const FIVE = { type: 'number', value: '5' }

function renderHand(options = {}) {
  const handlers = {
    onCardsChange: vi.fn(),
    onDuplicateAllowedChange: vi.fn(),
    onAttackChange: vi.fn(),
  }
  const view = renderHook(() => useHandEntry({ ...handlers, ...options }))
  return { ...handlers, view }
}

describe('useHandEntry', () => {
  it('tells the draft about each change', () => {
    const { view, onCardsChange, onDuplicateAllowedChange, onAttackChange } = renderHand()

    act(() => view.result.current.setCards([FIVE]))
    act(() => view.result.current.setOverride(true))
    act(() => view.result.current.setAttack('p2'))

    expect(onCardsChange).toHaveBeenCalledWith([FIVE])
    expect(onDuplicateAllowedChange).toHaveBeenCalledWith(true)
    expect(onAttackChange).toHaveBeenCalledWith('p2')
    expect(view.result.current.cards).toEqual([FIVE])
    expect(view.result.current.overrideOn).toBe(true)
  })

  it('does not call the draft when it is only opened', () => {
    const { onCardsChange } = renderHand({ start: { cards: [FIVE] } })

    expect(onCardsChange).not.toHaveBeenCalled()
  })

  it('keeps every change made in the same tap', () => {
    const { view } = renderHand()

    act(() => {
      view.result.current.setCards([FIVE])
      view.result.current.setOverride(true)
    })

    expect(view.result.current.cards).toEqual([FIVE])
    expect(view.result.current.overrideOn).toBe(true)
  })

  it('loading with nothing clears the hand and its choices, and the draft is told', () => {
    const { view, onCardsChange, onDuplicateAllowedChange, onAttackChange } = renderHand({
      start: { cards: [FIVE], duplicateAllowed: true, attackPlayerId: 'p2' },
    })

    act(() => view.result.current.load())

    expect(view.result.current.cards).toEqual([])
    expect(onCardsChange).toHaveBeenCalledWith([])
    expect(onDuplicateAllowedChange).toHaveBeenCalledWith(false)
    expect(onAttackChange).toHaveBeenCalledWith(null)
  })

  it('works with no draft to save', () => {
    const { result } = renderHook(() => useHandEntry({ start: { cards: [FIVE], busted: true }, allowsEmptyHand: true }))

    act(() => result.current.setBust(false))
    act(() => result.current.setCards([]))
    act(() => result.current.setOverride(true))
    act(() => result.current.setAttack('p2'))
    act(() => result.current.load())

    expect(result.current.isBustOn).toBe(false)
    expect(result.current.canConfirm).toBe(true)
  })
})
