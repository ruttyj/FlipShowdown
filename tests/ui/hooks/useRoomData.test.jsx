// useRoomData effects. The reducer and loader are tested in node.
import { act, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRoomData, useValueTransition } from '@/hooks/useRoomData'
import { makePlayer, makeRoom, renderGameHook, ROOM_CODE, ROOM_ID } from '../fixtures/renderGameHook.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

const LAST_ROOM_KEY = 'flip7_last_room'
const ENTITY_NAMES = ['GameRoom', 'Player', 'RoundScore', 'ChatMessage']

const ME = makePlayer('p1', { is_host: true })

function memberLookup() {
  return { room: makeRoom(), players: [ME], my_player: ME }
}

function outsiderLookup() {
  return { room: makeRoom(), players: [{ id: 'p1', name: 'p1' }], my_player: null }
}

function roomNotFound() {
  return Object.assign(new Error('gone'), { status: 404 })
}

/** Renders useRoomData with the room code as the hook's props, and loads it as `lookup`. */
async function renderRoom(lookup, configure = () => {}) {
  const view = renderGameHook((fixture, code) => useRoomData(code), { initialProps: null })
  view.game.lookupRoom.mockResolvedValue(lookup)
  view.backend.entities.GameRoom.filter.mockResolvedValue([makeRoom()])
  view.backend.entities.Player.filter.mockResolvedValue([ME])
  configure(view)
  // Start without a room so the fakes are set up before the first fetch.
  view.rerender(ROOM_CODE)
  await waitFor(() => expect(view.result.current.status).not.toBe('loading'))
  return view
}

function renderMember(configure) {
  return renderRoom(memberLookup(), configure)
}

function setVisibility(state) {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state)
  document.dispatchEvent(new Event('visibilitychange'))
}

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('subscription', () => {
  it('subscribes once the player is a member', async () => {
    const view = await renderMember()

    expect(view.result.current.isMember).toBe(true)
    expect(view.realtime.setRooms).toHaveBeenCalledWith([ROOM_ID])
    for (const name of ENTITY_NAMES) {
      expect(view.backend.entities[name].subscribe).toHaveBeenCalledTimes(1)
    }
  })

  it('does not subscribe when not a member', async () => {
    const view = await renderRoom(outsiderLookup())

    expect(view.result.current.isMember).toBe(false)
    expect(view.realtime.setRooms).not.toHaveBeenCalled()
  })

  it('unsubscribes on unmount', async () => {
    const off = vi.fn()
    const view = await renderMember((rendered) => {
      rendered.backend.entities.Player.subscribe.mockReturnValue(off)
    })

    view.unmount()

    expect(off).toHaveBeenCalledTimes(1)
    expect(view.realtime.setRooms).toHaveBeenLastCalledWith([])
  })

  it('unsubscribes on a room change', async () => {
    const off = vi.fn()
    const view = await renderMember((rendered) => {
      rendered.backend.entities.Player.subscribe.mockReturnValue(off)
    })

    view.game.lookupRoom.mockResolvedValue(outsiderLookup())
    view.rerender('ZZZ999')

    await waitFor(() => expect(off).toHaveBeenCalledTimes(1))
    expect(view.realtime.setRooms).toHaveBeenLastCalledWith([])
  })
})

describe('refetch triggers', () => {
  async function expectOneRefetch(view, trigger) {
    const before = view.game.lookupRoom.mock.calls.length

    await act(async () => {
      trigger()
    })

    await waitFor(() => expect(view.game.lookupRoom.mock.calls.length).toBe(before + 1))
  }

  it('refetches on realtime ready', async () => {
    const view = await renderMember()

    await expectOneRefetch(view, () => view.emitRealtime('ready'))
  })

  it('refetches on resync', async () => {
    const view = await renderMember()

    await expectOneRefetch(view, () => view.emitRealtime('resync'))
  })

  it('refetches when the tab becomes visible again, not when it hides', async () => {
    const view = await renderMember()
    const before = view.game.lookupRoom.mock.calls.length

    await act(async () => {
      setVisibility('hidden')
    })
    expect(view.game.lookupRoom.mock.calls.length).toBe(before)

    await expectOneRefetch(view, () => setVisibility('visible'))
  })

  it('refetches when the browser comes back online', async () => {
    const view = await renderMember()

    await expectOneRefetch(view, () => window.dispatchEvent(new Event('online')))
  })
})

describe('last room', () => {
  it('is saved while a member', async () => {
    await renderMember()

    expect(JSON.parse(localStorage.getItem(LAST_ROOM_KEY))).toEqual({ code: ROOM_CODE })
  })

  it('is cleared when the room is gone', async () => {
    const view = await renderMember()

    view.game.lookupRoom.mockRejectedValue(roomNotFound())
    await act(() => view.result.current.refetch())

    await waitFor(() => expect(view.result.current.roomGone).toBe(true))
    expect(localStorage.getItem(LAST_ROOM_KEY)).toBeNull()
  })

  it('is cleared when I was removed', async () => {
    const view = await renderMember()

    view.game.lookupRoom.mockResolvedValue({ room: makeRoom(), players: [], my_player: null })
    await act(() => view.result.current.refetch())

    await waitFor(() => expect(view.result.current.removedFromRoom).toBe(true))
    expect(localStorage.getItem(LAST_ROOM_KEY)).toBeNull()
  })

  it('leaves another room code alone when clearing', async () => {
    const view = await renderMember()
    localStorage.setItem(LAST_ROOM_KEY, JSON.stringify({ code: 'OTHER1' }))

    view.game.lookupRoom.mockRejectedValue(roomNotFound())
    await act(() => view.result.current.refetch())

    await waitFor(() => expect(view.result.current.roomGone).toBe(true))
    expect(JSON.parse(localStorage.getItem(LAST_ROOM_KEY))).toEqual({ code: 'OTHER1' })
  })

  it('does not throw when storage is blocked', async () => {
    const blocked = () => {
      throw new Error('blocked')
    }
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(blocked)

    const view = await renderMember()
    expect(view.result.current.isMember).toBe(true)

    view.game.lookupRoom.mockRejectedValue(roomNotFound())
    await act(() => view.result.current.refetch())

    await waitFor(() => expect(view.result.current.roomGone).toBe(true))
  })
})

describe('useValueTransition', () => {
  it('calls back on change only, with the latest callback', () => {
    const first = vi.fn()
    const second = vi.fn()
    const view = renderGameHook((fixture, props) => useValueTransition(props.value, props.callback), {
      initialProps: { value: 'a', callback: first },
    })
    expect(first).toHaveBeenCalledWith(undefined, 'a')

    view.rerender({ value: 'a', callback: second })
    expect(second).not.toHaveBeenCalled()
    expect(first).toHaveBeenCalledTimes(1)

    view.rerender({ value: 'b', callback: second })
    expect(second).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledWith('a', 'b')
    expect(first).toHaveBeenCalledTimes(1)
  })
})
