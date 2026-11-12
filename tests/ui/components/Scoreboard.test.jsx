// Scoreboard, including X15.
import React from 'react'
import { render, screen, within } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import Scoreboard from '@/components/game/Scoreboard'
import { makePlayer } from '../fixtures/renderGameHook.jsx'

beforeAll(() => {
  // jsdom has no scrollTo on elements; the board scrolls itself on score changes.
  Element.prototype.scrollTo = vi.fn()
})

function makeScore(playerId, round, finalScore) {
  return { player_id: playerId, round_number: round, final_score: finalScore }
}

function columnHeaders() {
  return screen.getAllByRole('columnheader').map((header) => header.textContent)
}

function rowFor(name) {
  return screen.getByText(name).closest('tr')
}

describe('Scoreboard', () => {
  it('takes its header colour from the theme', () => {
    render(<Scoreboard players={[]} currentRound={1} roundScores={[]} />)

    const header = screen.getByRole('heading', { name: 'Scoreboard' }).parentElement.parentElement.parentElement
    expect(header).toHaveClass('panel-header-bg')
    expect(header.className).not.toMatch(/indigo|purple/)
  })

  it('orders players by total, highest first, with the leader ranked 1', () => {
    const players = [
      makePlayer('a', { name: 'Ann', total_score: 10 }),
      makePlayer('b', { name: 'Bo', total_score: 40 }),
      makePlayer('c', { name: 'Cy', total_score: 25 }),
    ]
    render(<Scoreboard players={players} currentRound={1} roundScores={[]} />)

    const rows = screen.getAllByRole('row').slice(1)
    expect(rows.map((row) => within(row).getByText(/Ann|Bo|Cy/).textContent)).toEqual(['Bo', 'Cy', 'Ann'])
    expect(within(rows[0]).getByText('1')).toBeInTheDocument()
  })

  it('shows each played round as a column and a missing score as a dash, not 0', () => {
    const players = [
      makePlayer('a', { name: 'Ann', total_score: 30 }),
      makePlayer('b', { name: 'Bo', total_score: 5 }),
    ]
    const roundScores = [makeScore('a', 1, 30), makeScore('b', 1, 0), makeScore('a', 2, 12)]
    render(<Scoreboard players={players} currentRound={3} roundScores={roundScores} />)

    expect(columnHeaders()).toEqual(['Player', 'R1', 'R2', 'R3', 'Total'])
    const boCells = within(rowFor('Bo')).getAllByRole('cell').map((cell) => cell.textContent)
    // name, R1 (a real 0), R2 (missing), R3 (current), total
    expect(boCells.slice(1)).toEqual(['0', '-', '-', '5'])
  })

  it('marks my row with a "You" pill when given my player id', () => {
    const players = [makePlayer('a', { name: 'Ann' }), makePlayer('b', { name: 'Bo' })]
    render(<Scoreboard players={players} currentRound={1} roundScores={[]} currentPlayerId="b" />)

    expect(within(rowFor('Bo')).getByText('You')).toBeInTheDocument()
    expect(rowFor('Bo')).toHaveAttribute('aria-current', 'true')
    expect(within(rowFor('Ann')).queryByText('You')).not.toBeInTheDocument()
    expect(rowFor('Ann')).not.toHaveAttribute('aria-current')
  })

  it('marks no row as mine when no player id is given', () => {
    const players = [makePlayer('a', { name: 'Ann' }), makePlayer('b', { name: 'Bo' })]
    render(<Scoreboard players={players} currentRound={1} roundScores={[]} />)

    expect(screen.queryByText('You')).not.toBeInTheDocument()
  })

  // --- X45 ---------------------------------------------------------------------

  it('a busted round shows BUST, named for screen readers, and a plain 0 is just a 0', () => {
    const players = [makePlayer('a', { name: 'Sam' }), makePlayer('b', { name: 'Bo' })]
    const roundScores = [
      { ...makeScore('a', 1, 0), busted: true },
      makeScore('b', 1, 0),
    ]
    render(<Scoreboard players={players} currentRound={1} roundScores={roundScores} />)

    expect(screen.getByRole('cell', { name: 'Sam busted, 0 points' })).toHaveTextContent('BUST')
    const boCells = within(rowFor('Bo')).getAllByRole('cell')
    expect(boCells[1]).toHaveTextContent(/^0$/)
    expect(within(boCells[1]).getByText('0').className).not.toContain('text-red')
  })

  it('a busted round with a score shows it alongside', () => {
    const players = [makePlayer('a', { name: 'Sam' })]
    render(<Scoreboard players={players} currentRound={1} roundScores={[{ ...makeScore('a', 1, -6), busted: true }]} />)

    const cell = screen.getByRole('cell', { name: 'Sam busted, minus 6 points' })
    expect(cell).toHaveTextContent('BUST')
    expect(within(cell).getByText('−6')).toBeInTheDocument()
    // red-600 is under 4.5:1 on the current round's soft accent tint.
    expect(within(cell).getByText('BUST')).toHaveClass('text-red-700')
  })

  // --- X15 ---------------------------------------------------------------------

  it('shows the current round as exactly one column once someone has submitted in it (X15)', () => {
    const players = [makePlayer('a', { name: 'Ann', total_score: 20 }), makePlayer('b', { name: 'Bo' })]
    const roundScores = [makeScore('a', 1, 20)]
    render(<Scoreboard players={players} currentRound={1} roundScores={roundScores} />)

    expect(columnHeaders()).toEqual(['Player', 'R1', 'Total'])
    const annCells = within(rowFor('Ann')).getAllByRole('cell').map((cell) => cell.textContent)
    expect(annCells.slice(1)).toEqual(['20', '20'])
  })
})
