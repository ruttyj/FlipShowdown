// The score editor opening on a late score: the room turning edit mode on and the setEditMode reply
// can arrive in either order, and the editor must open on the score both ways.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatMuteProvider } from '@/hooks/useRoomChat'
import { SoundProvider } from '@/components/useSound'
import { AuthProvider } from '@/lib/AuthContext'
import { pendingCardsScope, savePendingCards } from '@/lib/pendingCards'
import GameRoom from '@/pages/GameRoom'
import { resetFakeApi } from '../fixtures/fakeApi.jsx'
import { createTestRoom } from '../fixtures/testRoom.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

const LATE_CARDS = [{ value: '9', type: 'number' }]

let room

beforeEach(() => {
  localStorage.setItem('flip7_sound_muted', 'true')
  room = createTestRoom({ players: ['p1', 'p2'], me: 'p1' })
  // Round 2, with cards left in a draft for round 1: the host gets asked about them on load.
  room.playRound()
  savePendingCards(sessionStorage, pendingCardsScope(room.id, 1), 1, { source: 'manual', cards: LATE_CARDS })
})

afterEach(() => {
  room.close()
})

function renderRoom() {
  resetFakeApi({ user: room.user })
  room.install()
  window.history.replaceState(null, '', room.url)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[room.url]}>
          <SoundProvider>
            <ChatMuteProvider>
              <GameRoom />
            </ChatMuteProvider>
          </SoundProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </AuthProvider>,
  )
}

async function acceptLateRoundPrompt() {
  const edit = await screen.findByRole('button', { name: 'Edit round 1' })
  await userEvent.click(edit)
}

/** The editor open on the late score shows that round's card, not the grid of scores. */
async function expectEditorOnLateScore() {
  await screen.findByText('Edit Mode Active')
  await waitFor(() => expect(screen.getByDisplayValue('9')).toBeInTheDocument())
}

describe('the editor opening on a late score', () => {
  it('opens on it when the reply arrives before the room update', async () => {
    const events = room.holdEvents()
    renderRoom()

    await acceptLateRoundPrompt()
    await act(async () => {
      events.release()
    })

    await expectEditorOnLateScore()
  })

  it('opens on it when the room update arrives before the reply', async () => {
    const replies = room.holdReplies()
    renderRoom()

    await acceptLateRoundPrompt()
    // The realtime event has switched the panel, and the exit animation has finished.
    await screen.findByText('Edit Mode Active')
    await act(async () => {
      replies.release()
    })

    await expectEditorOnLateScore()
  })

  it('opens on it when the editor is already showing its grid', async () => {
    room.as('p1', 'set-edit-mode', { on: true })
    renderRoom()

    await acceptLateRoundPrompt()

    await expectEditorOnLateScore()
  })
})
