// QuickSendBar and the useQuickSends hook.
import React from 'react'
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import QuickSendBar from '@/components/game/QuickSendBar'
import { ChatMuteProvider, useQuickSends, useRoomChat } from '@/hooks/useRoomChat'
import { fakeBackend as backend, resetFakeApi } from '../fixtures/fakeApi.jsx'
import { makePlayer } from '../fixtures/renderGameHook.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

const ME = makePlayer('me', { name: 'Me' })
const BO = makePlayer('p2', { name: 'Bo Lee' })
const CY = makePlayer('p3', { name: 'Cy' })

beforeEach(() => {
  resetFakeApi({})
  window.localStorage.clear()
  vi.spyOn(toast, 'success').mockImplementation(() => 'id')
  vi.spyOn(toast, 'error').mockImplementation(() => 'id')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

// --- useQuickSends -------------------------------------------------------------

describe('useQuickSends', () => {
  // Start from a saved empty list, so the defaults don't take up slots.
  beforeEach(() => {
    window.localStorage.setItem('quick_sends_room-1', JSON.stringify([]))
  })

  it('starts with the default quick sends when nothing is saved', () => {
    window.localStorage.removeItem('quick_sends_room-1')
    const { result } = renderHook(() => useQuickSends('room-1'))

    expect(result.current.quickSends.map((combo) => combo.emoji)).toEqual(['❤️', '🥶', '🤬', '🥷'])
  })

  it('keeps a saved list instead of the defaults, even an empty one', () => {
    window.localStorage.setItem('quick_sends_room-2', JSON.stringify([{ emoji: 'A', message: '', recipients: ['p2'] }]))

    expect(renderHook(() => useQuickSends('room-1')).result.current.quickSends).toEqual([])
    expect(renderHook(() => useQuickSends('room-2')).result.current.quickSends.map((combo) => combo.emoji)).toEqual(['A'])
  })

  it('adds a combo at the front and keeps only the newest four', () => {
    const { result } = renderHook(() => useQuickSends('room-1'))

    for (const emoji of ['1', '2', '3', '4', '5']) {
      act(() => result.current.saveQuickSend(emoji, '', ['p2']))
    }

    expect(result.current.quickSends.map((combo) => combo.emoji)).toEqual(['5', '4', '3', '2'])
    expect(JSON.parse(window.localStorage.getItem('quick_sends_room-1'))).toHaveLength(4)
  })

  it('saving the same emoji and message again moves it to the front without duplicating', () => {
    const { result } = renderHook(() => useQuickSends('room-1'))

    act(() => result.current.saveQuickSend('A', 'hi', ['p2']))
    act(() => result.current.saveQuickSend('B', '', ['p2']))
    act(() => result.current.saveQuickSend('A', 'hi', ['p3']))

    expect(result.current.quickSends).toEqual([
      { emoji: 'A', message: 'hi', recipients: ['p3'] },
      { emoji: 'B', message: '', recipients: ['p2'] },
    ])
    // Every chat send saves its combo, so saving is silent.
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('drops stored combos beyond the four shown, from screen and storage', () => {
    const stored = ['1', '2', '3', '4', '5', '6'].map((emoji) => ({ emoji, message: '', recipients: ['p2'] }))
    window.localStorage.setItem('quick_sends_room-1', JSON.stringify(stored))

    const { result } = renderHook(() => useQuickSends('room-1'))

    expect(result.current.quickSends.map((combo) => combo.emoji)).toEqual(['1', '2', '3', '4'])
    const persisted = JSON.parse(window.localStorage.getItem('quick_sends_room-1'))
    expect(persisted.map((combo) => combo.emoji)).toEqual(['1', '2', '3', '4'])
  })

  it('removes a combo by index', () => {
    const { result } = renderHook(() => useQuickSends('room-1'))
    act(() => result.current.saveQuickSend('A', '', ['p2']))
    act(() => result.current.saveQuickSend('B', '', ['p2']))

    act(() => result.current.deleteQuickSend(0))

    expect(result.current.quickSends.map((combo) => combo.emoji)).toEqual(['A'])
    expect(toast.success).toHaveBeenCalledWith('Quick send removed')
  })

  it('reorders combos and persists the new order', () => {
    const { result } = renderHook(() => useQuickSends('room-1'))
    for (const emoji of ['A', 'B', 'C']) {
      act(() => result.current.saveQuickSend(emoji, '', ['p2']))
    }
    // The list is now C, B, A.

    act(() => result.current.reorderQuickSend(0, 2))

    expect(result.current.quickSends.map((combo) => combo.emoji)).toEqual(['B', 'A', 'C'])
    const stored = JSON.parse(window.localStorage.getItem('quick_sends_room-1'))
    expect(stored.map((combo) => combo.emoji)).toEqual(['B', 'A', 'C'])
  })

  it('ignores an empty emoji', () => {
    const { result } = renderHook(() => useQuickSends('room-1'))

    act(() => result.current.saveQuickSend('', 'hi', ['p2']))

    expect(result.current.quickSends).toEqual([])
  })
})

// --- QuickSendBar --------------------------------------------------------------

const NO_MESSAGES = []

function BarInRoom({ players, isExpanded, onSend }) {
  const chat = useRoomChat({ status: 'ready', roomId: 'room-1', chatMessages: NO_MESSAGES, players, myPlayer: ME, cue: vi.fn() })
  return <QuickSendBar chat={chat} isExpanded={isExpanded} onSend={onSend} />
}

function renderBar(quickSends, otherPlayers = [BO, CY], { isExpanded = true, onSend = vi.fn() } = {}) {
  window.localStorage.setItem('quick_sends_room-1', JSON.stringify(quickSends))
  return render(<ChatMuteProvider><BarInRoom players={[ME, ...otherPlayers]} isExpanded={isExpanded} onSend={onSend} /></ChatMuteProvider>)
}

describe('QuickSendBar', () => {
  it('renders nothing without quick sends', () => {
    const { container } = renderBar([])

    expect(container).toBeEmptyDOMElement()
  })

  it('shows no buttons while folded into the chat button (X79)', () => {
    renderBar([{ emoji: '🎉', message: '', recipients: ['p2'] }], [BO, CY], { isExpanded: false })

    expect(screen.queryByRole('button', { name: /🎉/ })).not.toBeInTheDocument()
  })

  it('leaves movement and fading to framer-motion, so a CSS transition can\'t fight it and flicker', () => {
    renderBar([{ emoji: '🎉', message: '', recipients: ['p2'] }])

    const button = screen.getByRole('button', { name: /🎉/ })
    expect(button).not.toHaveClass('transition-all')
    expect(button).toHaveClass('transition-colors')
  })

  it('a send asks to fold the quick sends away (X79)', async () => {
    backend.entities.ChatMessage.create.mockResolvedValue({})
    const onSend = vi.fn()
    renderBar([{ emoji: '🎉', message: '', recipients: ['p2'] }], [BO, CY], { onSend })

    await userEvent.click(screen.getByRole('button', { name: /🎉/ }))

    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('one tap sends to every recipient, without a toast', async () => {
    backend.entities.ChatMessage.create.mockResolvedValue({})
    renderBar([{ emoji: '🎉', message: 'Yay', recipients: ['p2', 'p3'] }])

    await userEvent.click(screen.getByRole('button', { name: /🎉/ }))

    await waitFor(() => expect(backend.entities.ChatMessage.create).toHaveBeenCalledTimes(2))
    // The room-wide emoji animation is the confirmation (X31), so no success toast.
    await waitFor(() => expect(screen.getByRole('button', { name: /🎉/ })).toBeEnabled())
    expect(toast.success).not.toHaveBeenCalled()
    expect(backend.entities.ChatMessage.create.mock.calls.map(([body]) => body)).toEqual([
      { room_id: 'room-1', sender_id: 'me', recipient_id: 'p2', emoji: '🎉', message: 'Yay' },
      { room_id: 'room-1', sender_id: 'me', recipient_id: 'p3', emoji: '🎉', message: 'Yay' },
    ])
  })

  it('a default quick send goes to everyone still in the room', async () => {
    backend.entities.ChatMessage.create.mockResolvedValue({})
    renderBar([{ emoji: '❤️', message: '', recipients: [], toEveryone: true }])

    expect(screen.getByText('All')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /❤️/ }))

    await waitFor(() => expect(backend.entities.ChatMessage.create).toHaveBeenCalledTimes(2))
    const recipientIds = backend.entities.ChatMessage.create.mock.calls.map(([body]) => body.recipient_id)
    expect(recipientIds).toEqual(['p2', 'p3'])
  })

  it('labels the button with initials, or All when everyone is a recipient', () => {
    renderBar([
      { emoji: '🎉', message: '', recipients: ['p2'] },
      { emoji: '🔥', message: '', recipients: ['p2', 'p3'] },
    ])

    expect(screen.getByText('BL')).toBeInTheDocument()
    expect(screen.getByText('All')).toBeInTheDocument()
  })

  it('skips recipients who left and says so when none remain', async () => {
    renderBar([{ emoji: '🎉', message: '', recipients: ['gone'] }])

    await userEvent.click(screen.getByRole('button', { name: /🎉/ }))

    expect(toast.error).toHaveBeenCalledWith('No valid recipients — they may have left')
    expect(backend.entities.ChatMessage.create).not.toHaveBeenCalled()
  })

  it('a failed send shows Failed to send', async () => {
    backend.entities.ChatMessage.create.mockRejectedValue(new Error('offline'))
    renderBar([{ emoji: '🎉', message: '', recipients: ['p2'] }])

    await userEvent.click(screen.getByRole('button', { name: /🎉/ }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to send'))
  })

  it('a send that reaches only some says who missed it, and can be sent again (X60)', async () => {
    backend.entities.ChatMessage.create.mockImplementation(async ({ recipient_id: recipientId }) => {
      if (recipientId === 'p2') {
        throw new Error('offline')
      }
      return {}
    })
    renderBar([{ emoji: '🎉', message: '', recipients: ['p2', 'p3'] }])

    await userEvent.click(screen.getByRole('button', { name: /🎉/ }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Sent to Cy, but not to Bo Lee'))
    expect(backend.entities.ChatMessage.create).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(screen.getByRole('button', { name: /🎉/ })).toBeEnabled())
  })

  it('a combo saved with nobody does nothing', async () => {
    renderBar([{ emoji: '🎉', message: '', recipients: [] }])

    await userEvent.click(screen.getByRole('button', { name: /🎉/ }))

    expect(backend.entities.ChatMessage.create).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })
})
