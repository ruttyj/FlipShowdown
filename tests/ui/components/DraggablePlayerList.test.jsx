// DraggablePlayerList: the waiting room's player list.
import React from 'react'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import DraggablePlayerList from '@/components/game/DraggablePlayerList'

function makePlayer(id, overrides = {}) {
  return { id, name: id, turn_order: 0, games_won: 0, online: true, ...overrides }
}

function rowOf(name) {
  return screen.getByText(name).closest('[data-rfd-draggable-id]')
}

describe('who is online', () => {
  it('shows a green dot next to an online player', () => {
    render(<DraggablePlayerList players={[makePlayer('Bo')]} currentPlayerId="me" />)

    expect(within(rowOf('Bo')).getByTitle('Online').className).toContain('bg-emerald-500')
  })

  it('shows a grey dot next to an offline player, as well as the label', () => {
    render(<DraggablePlayerList players={[makePlayer('Bo', { online: false })]} currentPlayerId="me" />)

    expect(within(rowOf('Bo')).getByTitle('Offline').className).toContain('bg-slate-300')
    expect(within(rowOf('Bo')).getByText('offline')).toBeInTheDocument()
  })

  it('shows me as online even when my presence lags', () => {
    render(<DraggablePlayerList players={[makePlayer('Me', { online: false })]} currentPlayerId="Me" />)

    expect(within(rowOf('Me')).getByTitle('Online')).toBeInTheDocument()
  })
})
