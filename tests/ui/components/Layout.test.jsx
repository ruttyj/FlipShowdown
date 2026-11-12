// Layout: the screen lock runs with no control for it (X28), and the chat mute button sits in
// the toggle stack on the game room route only (X44).
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { expect, test, vi } from 'vitest'
import Layout from '@/Layout'
import { resetFakeApi } from '../fixtures/fakeApi.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

const ROOM_URL = '/room/ABC234'

function renderLayout(url) {
  resetFakeApi()
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Layout>
        <p>Page content</p>
      </Layout>
    </MemoryRouter>,
  )
}

// --- Screen lock -----------------------------------------------------------------

test('holds the screen lock on any page, with no toggle to turn it off', async () => {
  const request = vi.spyOn(navigator.wakeLock, 'request')

  renderLayout('/')

  await waitFor(() => expect(request).toHaveBeenCalledWith('screen'))
  expect(screen.getByText('Page content')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /keep the screen on/i })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /let the screen sleep/i })).not.toBeInTheDocument()
})

// --- Chat mute button ------------------------------------------------------------

test('shows the chat mute button in a game room, above the sound toggle', () => {
  renderLayout(ROOM_URL)

  const muteChat = screen.getByRole('button', { name: 'Mute chat' })
  const muteSounds = screen.getByRole('button', { name: 'Mute sounds' })
  expect(muteChat.compareDocumentPosition(muteSounds) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

test('hides the chat mute button on Home, which has no chat', () => {
  renderLayout('/')

  expect(screen.getByRole('button', { name: 'Mute sounds' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /mute chat/i })).not.toBeInTheDocument()
})

test('a saved mute shows as Unmute chat', () => {
  localStorage.setItem('flip7_chat_muted', 'true')

  renderLayout(ROOM_URL)

  expect(screen.getByRole('button', { name: 'Unmute chat' })).toBeInTheDocument()
})
