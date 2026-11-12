// ScoreSummary.
import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import ScoreSummary from '@/components/game/ScoreSummary'

function makeScore(overrides = {}) {
  return { baseSum: 10, multiplier: 1, adder: 0, bonus: 0, finalScore: 10, isDuplicateBust: false, warnings: [], ...overrides }
}

describe('ScoreSummary', () => {
  it('shows the working and the final score', () => {
    render(<ScoreSummary score={makeScore({ baseSum: 10, multiplier: 2, bonus: 15, finalScore: 35 })} />)

    expect(screen.getByText('10 × 2 + 15 =')).toBeInTheDocument()
    expect(screen.getByText('35')).toBeInTheDocument()
  })

  it('shows the working, not a bust, when modifiers bring the score to 0 (X25)', () => {
    // 13 + 0 = 13, ÷ 2 = 6.5, − 6 = 0.5, rounded down to 0.
    render(<ScoreSummary score={makeScore({ baseSum: 13, multiplier: 0.5, adder: -6, finalScore: 0 })} />)

    expect(screen.getByText('13 ÷ 2 − 6 =')).toBeInTheDocument()
    expect(screen.getByText('0')).toBeInTheDocument()
    expect(screen.queryByText(/bust/i)).not.toBeInTheDocument()
  })

  it('shows a declared bust as a bust, not as duplicate cards (X45)', () => {
    render(<ScoreSummary score={makeScore({ finalScore: 0, isBust: true })} />)

    expect(screen.getByText('Bust')).toBeInTheDocument()
    expect(screen.queryByText('Duplicate Cards')).not.toBeInTheDocument()
    expect(screen.getByText('0').className).toContain('text-red')
  })

  it('shows a lone 0 card as a normal total (X25)', () => {
    render(<ScoreSummary score={makeScore({ baseSum: 0, finalScore: 0 })} />)

    expect(screen.getByText('Total:')).toBeInTheDocument()
    expect(screen.queryByText(/bust/i)).not.toBeInTheDocument()
  })

  it('shows a negative total with its working (X25)', () => {
    render(<ScoreSummary score={makeScore({ baseSum: 5, adder: -10, finalScore: -5 })} />)

    expect(screen.getByText('5 − 10 =')).toBeInTheDocument()
    expect(screen.getByText('−5')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByText('minus 5')).toHaveClass('sr-only')
  })

  it('has one copy of a score that needs no words', () => {
    render(<ScoreSummary score={makeScore({ finalScore: 7 })} />)

    expect(screen.getByText('7')).not.toHaveAttribute('aria-hidden')
  })

  // red-600 is under 4.5:1 on both of the summary's tints.
  it.each([
    ['a bust', { finalScore: -6, isBust: true }, '−6'],
    ['a negative score', { baseSum: 5, adder: -10, finalScore: -5 }, '−5'],
  ])('%s uses a red that reads on the tint', (_name, fields, shown) => {
    render(<ScoreSummary score={makeScore(fields)} />)

    expect(screen.getByText(shown)).toHaveClass('text-red-700')
  })

  it('a bust\'s label uses a red that reads on the tint', () => {
    render(<ScoreSummary score={makeScore({ finalScore: 0, isBust: true })} />)

    expect(screen.getByText('Bust')).toHaveClass('text-red-700')
  })

  it('shows Duplicate Cards for a duplicate bust', () => {
    render(<ScoreSummary score={makeScore({ finalScore: 0, isDuplicateBust: true, isBust: true })} />)

    expect(screen.getByText('Duplicate Cards')).toBeInTheDocument()
  })

  describe('announcing the Flip 7 choice', () => {
    const SAM = { id: 'sam', name: 'Sam' }
    const attack = { targets: [SAM], chosenId: null, onChoose: () => {} }
    const flipSeven = (fields = {}) => makeScore({
      finalScore: 43,
      bonus: 15,
      offersFlip7Attack: true,
      flip7AttackPlayerId: null,
      ...fields,
    })
    const liveRegion = (container) => container.querySelector('[aria-live="polite"]')

    it('stays silent while a hand with no choice is being typed', () => {
      const { container, rerender } = render(<ScoreSummary score={makeScore({ finalScore: 10 })} attack={attack} />)
      const region = liveRegion(container)
      expect(region).toBeEmptyDOMElement()

      rerender(<ScoreSummary score={makeScore({ finalScore: 14 })} attack={attack} />)

      expect(liveRegion(container)).toBe(region)
      expect(region).toBeEmptyDOMElement()
    })

    it('announces the chooser appearing, in a region that was already there', () => {
      const { container, rerender } = render(<ScoreSummary score={makeScore()} attack={attack} />)
      const region = liveRegion(container)

      rerender(<ScoreSummary score={flipSeven()} attack={attack} />)

      expect(liveRegion(container)).toBe(region)
      expect(region).toHaveTextContent('Flip 7! You can keep the +15 or take 15 from a rival. Keeping the +15. Your score is 43.')
    })

    it('announces the score that goes with each choice', () => {
      const { container, rerender } = render(<ScoreSummary score={flipSeven()} attack={attack} />)

      rerender(<ScoreSummary score={flipSeven({ finalScore: 28, bonus: 0, flip7AttackPlayerId: 'sam' })} attack={attack} />)
      expect(liveRegion(container)).toHaveTextContent(/^Taking 15 from Sam\. Your score is 28\.$/)

      rerender(<ScoreSummary score={flipSeven()} attack={attack} />)
      expect(liveRegion(container)).toHaveTextContent(/^Keeping the \+15\. Your score is 43\.$/)
    })

    it('says "minus" for a choice that leaves the score below 0', () => {
      const { container, rerender } = render(<ScoreSummary score={flipSeven({ finalScore: 5 })} attack={attack} />)

      rerender(<ScoreSummary score={flipSeven({ finalScore: -10, bonus: 0, flip7AttackPlayerId: 'sam' })} attack={attack} />)

      expect(liveRegion(container)).toHaveTextContent('Your score is minus 10.')
    })

    it('stays quiet when typing changes the score while the choice stays', () => {
      const { container, rerender } = render(<ScoreSummary score={flipSeven()} attack={attack} />)
      const announced = liveRegion(container).textContent

      rerender(<ScoreSummary score={flipSeven({ finalScore: 39 })} attack={attack} />)

      expect(liveRegion(container).textContent).toBe(announced)
    })

    it('goes quiet when the hand stops being a Flip 7, so the next one is announced again', () => {
      const { container, rerender } = render(<ScoreSummary score={flipSeven()} attack={attack} />)

      rerender(<ScoreSummary score={makeScore()} attack={attack} />)
      expect(liveRegion(container)).toBeEmptyDOMElement()

      rerender(<ScoreSummary score={flipSeven()} attack={attack} />)
      expect(liveRegion(container)).toHaveTextContent(/^Flip 7!/)
    })

    it('has nothing to announce with nobody to attack', () => {
      const { container } = render(<ScoreSummary score={flipSeven()} attack={{ ...attack, targets: [] }} />)

      expect(liveRegion(container)).toBeEmptyDOMElement()
    })
  })
})
