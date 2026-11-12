// useDuplicateTab.
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useDuplicateTab } from '@/hooks/useDuplicateTab'
import { byeMessage, DUPLICATE_TAB_CHANNEL, helloMessage } from '@/lib/duplicateTab'

// Lets queued BroadcastChannel deliveries run.
async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function openObserver() {
  const channel = new BroadcastChannel(DUPLICATE_TAB_CHANNEL)
  const received = []
  channel.onmessage = (event) => received.push(event.data)
  return { channel, received }
}

describe('useDuplicateTab', () => {
  it('announces on mount', async () => {
    const { received } = openObserver()

    renderHook(() => useDuplicateTab('room1'))
    await flush()

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ type: 'hello', roomId: 'room1' })
  })

  it('reports another tab on the same room, and ignores other rooms', async () => {
    const view = renderHook(() => useDuplicateTab('room1'))
    const { channel } = openObserver()
    await flush()
    expect(view.result.current).toBe(false)

    channel.postMessage(helloMessage('other-room', 'tabX'))
    await flush()
    expect(view.result.current).toBe(false)

    channel.postMessage(helloMessage('room1', 'tabY'))
    await flush()
    expect(view.result.current).toBe(true)
  })

  it('replies present to a hello, and clears when the other tab says bye', async () => {
    const view = renderHook(() => useDuplicateTab('room1'))
    const { channel, received } = openObserver()

    channel.postMessage(helloMessage('room1', 'tabY'))
    await flush()
    expect(received.some((message) => message.type === 'present')).toBe(true)
    expect(view.result.current).toBe(true)

    channel.postMessage(byeMessage('room1', 'tabY'))
    await flush()
    expect(view.result.current).toBe(false)
  })

  it('says bye on unmount', async () => {
    const { received } = openObserver()
    const view = renderHook(() => useDuplicateTab('room1'))
    await flush()

    view.unmount()
    await flush()

    expect(received.at(-1)).toMatchObject({ type: 'bye', roomId: 'room1' })
  })

  it('says bye on pagehide, and hello again on a persisted pageshow', async () => {
    const { received } = openObserver()
    renderHook(() => useDuplicateTab('room1'))
    await flush()

    window.dispatchEvent(new Event('pagehide'))
    await flush()
    expect(received.at(-1).type).toBe('bye')

    const notPersisted = new Event('pageshow')
    notPersisted.persisted = false
    window.dispatchEvent(notPersisted)
    await flush()
    expect(received.at(-1).type).toBe('bye')

    const persisted = new Event('pageshow')
    persisted.persisted = true
    window.dispatchEvent(persisted)
    await flush()
    expect(received.at(-1).type).toBe('hello')
  })

  it('does nothing without a room id', async () => {
    const { received } = openObserver()

    const view = renderHook(() => useDuplicateTab(null))
    await flush()

    expect(received).toHaveLength(0)
    expect(view.result.current).toBe(false)
  })

  it('does nothing when BroadcastChannel is unavailable', () => {
    const original = globalThis.BroadcastChannel
    delete globalThis.BroadcastChannel
    try {
      const view = renderHook(() => useDuplicateTab('room1'))
      expect(view.result.current).toBe(false)
    } finally {
      globalThis.BroadcastChannel = original
    }
  })

  it('starts over when the room changes', async () => {
    const view = renderHook(({ roomId }) => useDuplicateTab(roomId), { initialProps: { roomId: 'room1' } })
    const { channel } = openObserver()
    channel.postMessage(helloMessage('room1', 'tabY'))
    await flush()
    expect(view.result.current).toBe(true)

    view.rerender({ roomId: 'room2' })
    await flush()

    expect(view.result.current).toBe(false)
  })
})
