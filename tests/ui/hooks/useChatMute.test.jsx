// ChatMuteProvider: the per-device chat mute preference and the pulse counter (X44).
import { act, renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { ChatMuteProvider, useChatMute } from '@/hooks/useRoomChat'

const CHAT_MUTE_KEY = 'flip7_chat_muted'

function renderChatMute() {
  return renderHook(() => useChatMute(), { wrapper: ChatMuteProvider })
}

function blockStorage() {
  const blocked = () => {
    throw new Error('blocked')
  }
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked)
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked)
}

// --- Preference ------------------------------------------------------------------

test('is unmuted by default', () => {
  const view = renderChatMute()

  expect(view.result.current.isChatMuted).toBe(false)
  expect(view.result.current.pulseKey).toBe(0)
})

test('toggling saves the preference, and it survives a remount', () => {
  const view = renderChatMute()

  act(() => view.result.current.toggleChatMute())
  expect(view.result.current.isChatMuted).toBe(true)
  expect(localStorage.getItem(CHAT_MUTE_KEY)).toBe('true')

  view.unmount()
  const remounted = renderChatMute()
  expect(remounted.result.current.isChatMuted).toBe(true)

  act(() => remounted.result.current.toggleChatMute())
  expect(remounted.result.current.isChatMuted).toBe(false)
  expect(localStorage.getItem(CHAT_MUTE_KEY)).toBe('false')
})

test('a stored value that is not true counts as unmuted', () => {
  localStorage.setItem(CHAT_MUTE_KEY, '"yes"')

  expect(renderChatMute().result.current.isChatMuted).toBe(false)
})

test('bad JSON in storage counts as unmuted', () => {
  localStorage.setItem(CHAT_MUTE_KEY, '{bad')

  expect(renderChatMute().result.current.isChatMuted).toBe(false)
})

test('blocked storage: starts unmuted and the toggle still works for this page load', () => {
  blockStorage()
  const view = renderChatMute()
  expect(view.result.current.isChatMuted).toBe(false)

  act(() => view.result.current.toggleChatMute())

  expect(view.result.current.isChatMuted).toBe(true)
})

// --- Pulse -----------------------------------------------------------------------

test('each muted message gets a new pulse key, and the notifier stays the same function', () => {
  const view = renderChatMute()
  const notify = view.result.current.notifyMutedMessage

  act(() => notify())
  expect(view.result.current.pulseKey).toBe(1)

  act(() => notify())
  expect(view.result.current.pulseKey).toBe(2)
  expect(view.result.current.notifyMutedMessage).toBe(notify)
})

// --- Wiring ----------------------------------------------------------------------

test('useChatMute outside the provider says what is missing', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})

  expect(() => renderHook(() => useChatMute())).toThrow(/ChatMuteProvider/)
})
