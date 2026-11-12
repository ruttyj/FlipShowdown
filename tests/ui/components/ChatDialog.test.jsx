// ChatDialog.
import React, { useEffect } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import ChatDialog from '@/components/game/ChatDialog'
import { ChatMuteProvider, useRoomChat } from '@/hooks/useRoomChat'
import { fakeBackend as backend, resetFakeApi } from '../fixtures/fakeApi.jsx'
import { makePlayer } from '../fixtures/renderGameHook.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

const ME = makePlayer('me', { name: 'Me' })
const OTHERS = [makePlayer('p2', { name: 'Bo' }), makePlayer('p3', { name: 'Cy' })]

beforeEach(() => {
  user = userEvent.setup({ delay: null })
  resetFakeApi({})
  window.localStorage.clear()
  vi.spyOn(toast, 'success').mockImplementation(() => 'id')
  vi.spyOn(toast, 'error').mockImplementation(() => 'id')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const NO_MESSAGES = []
const PLAYERS = [ME, ...OTHERS]

function OpenDialog() {
  const chat = useRoomChat({ status: 'ready', roomId: 'room-1', chatMessages: NO_MESSAGES, players: PLAYERS, myPlayer: ME, cue: vi.fn() })
  useEffect(() => {
    chat.toggleOpen()
  }, [])
  return <ChatDialog chat={chat} />
}

function renderDialog() {
  render(<ChatMuteProvider><OpenDialog /></ChatMuteProvider>)
}

function savedQuickSends() {
  return JSON.parse(window.localStorage.getItem('quick_sends_room-1'))
}

function sentTo() {
  return backend.entities.ChatMessage.create.mock.calls.map(([body]) => body.recipient_id)
}

function failFor(failingIds) {
  backend.entities.ChatMessage.create.mockImplementation(async ({ recipient_id: recipientId }) => {
    if (failingIds.includes(recipientId)) {
      throw new Error('offline')
    }
    return {}
  })
}

function expectClosed() {
  return waitFor(() => expect(screen.queryByLabelText('Send')).not.toBeInTheDocument())
}

// The real emoji-picker-react renders hundreds of emoji (about 10 s per file under load).
// This stand-in keeps the contract ChatDialog relies on: onEmojiClick receives { emoji }.
vi.mock('emoji-picker-react', () => ({
  default: ({ onEmojiClick, searchPlaceholder }) => (
    <div>
      <input placeholder={searchPlaceholder} />
      <button type="button" onClick={() => onEmojiClick({ emoji: '😀' })}>
        Pick grinning face
      </button>
    </div>
  ),
}))

let user

async function pickEmoji() {
  await user.click(screen.getByRole('button', { name: 'Pick grinning face' }))
}

describe('ChatDialog', () => {
  it('sends the emoji and message to the first player and closes, without a toast', async () => {
    backend.entities.ChatMessage.create.mockResolvedValue({})
    renderDialog()

    await pickEmoji()
    await user.click(screen.getByPlaceholderText('Type a message...'))
    await user.paste('Nice one')
    await user.click(screen.getByLabelText('Send'))

    await expectClosed()
    // The room-wide emoji animation is the confirmation (X31), so no success toast.
    expect(toast.success).not.toHaveBeenCalled()
    expect(backend.entities.ChatMessage.create).toHaveBeenCalledTimes(1)
    expect(backend.entities.ChatMessage.create).toHaveBeenCalledWith({
      room_id: 'room-1',
      sender_id: 'me',
      recipient_id: 'p2',
      emoji: '😀',
      message: 'Nice one',
    })
  })

  it('posts one message per selected recipient', async () => {
    backend.entities.ChatMessage.create.mockResolvedValue({})
    renderDialog()

    await user.click(screen.getByText('Cy'))
    await pickEmoji()
    await user.click(screen.getByLabelText('Send'))

    await waitFor(() => expect(backend.entities.ChatMessage.create).toHaveBeenCalledTimes(2))
    const recipients = backend.entities.ChatMessage.create.mock.calls.map(([body]) => body.recipient_id)
    expect(recipients).toEqual(['p2', 'p3'])
  })

  it('a failed send shows Failed to send and keeps the draft', async () => {
    backend.entities.ChatMessage.create.mockRejectedValue(new Error('offline'))
    renderDialog()

    await pickEmoji()
    await user.click(screen.getByPlaceholderText('Type a message...'))
    await user.paste('Nice one')
    await user.click(screen.getByLabelText('Send'))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to send'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByPlaceholderText('Type a message...')).toHaveValue('Nice one')
    expect(screen.getByLabelText('Clear emoji')).toBeInTheDocument()
  })

  it('a successful send saves the combo as a quick send', async () => {
    backend.entities.ChatMessage.create.mockResolvedValue({})
    renderDialog()

    await user.click(screen.getByText('Cy'))
    await pickEmoji()
    await user.click(screen.getByPlaceholderText('Type a message...'))
    await user.paste('Nice one')
    await user.click(screen.getByLabelText('Send'))

    await expectClosed()
    expect(savedQuickSends()[0]).toEqual({ emoji: '😀', message: 'Nice one', recipients: ['p2', 'p3'] })
  })

  it('a failed send saves nothing', async () => {
    backend.entities.ChatMessage.create.mockRejectedValue(new Error('offline'))
    renderDialog()

    await pickEmoji()
    await user.click(screen.getByLabelText('Send'))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to send'))
    expect(savedQuickSends()).toBeNull()
  })

  it('has no manual save-as-quick-send button', async () => {
    renderDialog()

    await pickEmoji()

    expect(screen.queryByTitle('Save as quick send')).not.toBeInTheDocument()
  })

  describe('a send that reaches only some players (X60)', () => {
    async function sendToBoth() {
      await user.click(screen.getByText('Cy'))
      await pickEmoji()
      await user.click(screen.getByLabelText('Send'))
    }

    it('tries everyone, names who missed it and keeps the draft aimed at them', async () => {
      failFor(['p2'])
      renderDialog()

      await sendToBoth()

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Sent to Cy, but not to Bo'))
      expect(sentTo()).toEqual(['p2', 'p3'])
      expect(screen.getByLabelText('Clear emoji')).toBeInTheDocument()
      expect(screen.getByText('Bo')).toHaveClass('bg-ui-accent')
      expect(screen.getByText('Cy')).not.toHaveClass('bg-ui-accent')
    })

    it('sending again goes only to who missed it, then closes', async () => {
      failFor(['p2'])
      renderDialog()
      await sendToBoth()
      await waitFor(() => expect(toast.error).toHaveBeenCalled())

      failFor([])
      backend.entities.ChatMessage.create.mockClear()
      await user.click(screen.getByLabelText('Send'))

      await expectClosed()
      expect(sentTo()).toEqual(['p2'])
    })

    it('the quick send and remembered players keep everyone it was meant for, through a retry', async () => {
      failFor(['p2'])
      renderDialog()
      await sendToBoth()
      await waitFor(() => expect(toast.error).toHaveBeenCalled())
      expect(savedQuickSends()[0].recipients).toEqual(['p2', 'p3'])

      failFor([])
      await user.click(screen.getByLabelText('Send'))

      await expectClosed()
      expect(savedQuickSends()[0].recipients).toEqual(['p2', 'p3'])
      expect(savedQuickSends().filter((combo) => combo.emoji === '😀')).toHaveLength(1)
      expect(JSON.parse(window.localStorage.getItem('chat_recipients_room-1'))).toEqual(['p2', 'p3'])
    })

    it('a retry that fails again leaves it aimed at them', async () => {
      failFor(['p2'])
      renderDialog()
      await sendToBoth()
      await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))

      await user.click(screen.getByLabelText('Send'))

      await waitFor(() => expect(toast.error).toHaveBeenLastCalledWith('Failed to send'))
      expect(screen.getByLabelText('Clear emoji')).toBeInTheDocument()
      expect(savedQuickSends()[0].recipients).toEqual(['p2', 'p3'])
    })
  })

  it('opens on the players last chosen who are still here', async () => {
    window.localStorage.setItem('chat_recipients_room-1', JSON.stringify(['gone', 'p3']))
    renderDialog()

    await waitFor(() => expect(screen.getByText('Cy')).toHaveClass('bg-ui-accent'))
    expect(screen.getByText('Bo')).not.toHaveClass('bg-ui-accent')
  })

  it('a corrupt remembered list falls back to the first player', async () => {
    window.localStorage.setItem('chat_recipients_room-1', JSON.stringify({ not: 'a list' }))
    renderDialog()

    await waitFor(() => expect(screen.getByText('Bo')).toHaveClass('bg-ui-accent'))
  })

  it('Send is disabled until an emoji is chosen', () => {
    renderDialog()

    expect(screen.getByLabelText('Send')).toBeDisabled()
  })
})
