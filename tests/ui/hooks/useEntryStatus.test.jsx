// The entering-cards indicator's two hooks:
//   useEntryStatus({ roomId, round, state })  tells the room what I am doing
//   useEnteringPlayers({ roomId, round, players, currentPlayerId })  who else is entering
import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEnteringPlayers, useEntryStatus } from '@/hooks/useEntryStatus'
import { makePlayer, renderGameHook, ROOM_ID } from '../fixtures/renderGameHook.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

const HEARTBEAT_MS = 15_000

// --- Sending my status ---------------------------------------------------------------

function renderSender(props = {}) {
  const initialProps = { roomId: ROOM_ID, round: 1, state: 'typing', ...props }
  return renderGameHook((_fixture, hookProps) => useEntryStatus(hookProps), { initialProps })
}

function setVisibility(state) {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state)
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useEntryStatus: announcing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('announces typing for the round as soon as I start entering', () => {
    const view = renderSender({ state: 'typing', round: 3 })

    expect(view.realtime.entryStatus).toHaveBeenCalledTimes(1)
    expect(view.realtime.entryStatus).toHaveBeenCalledWith(ROOM_ID, 'typing', 3)
  })

  it('announces nothing while I am not entering', () => {
    const view = renderSender({ state: null })

    expect(view.realtime.entryStatus).not.toHaveBeenCalled()
  })

  it('announces nothing without a room', () => {
    const view = renderSender({ roomId: null })

    expect(view.realtime.entryStatus).not.toHaveBeenCalled()
  })

  it('announces a change from typing to scanning', () => {
    const view = renderSender({ state: 'typing' })

    view.rerender({ roomId: ROOM_ID, round: 1, state: 'scanning' })

    expect(view.realtime.entryStatus).toHaveBeenLastCalledWith(ROOM_ID, 'scanning', 1)
    expect(view.realtime.entryStatus).toHaveBeenCalledTimes(2)
  })

  it('announces null when I stop entering', () => {
    const view = renderSender({ state: 'typing' })

    view.rerender({ roomId: ROOM_ID, round: 1, state: null })

    expect(view.realtime.entryStatus).toHaveBeenLastCalledWith(ROOM_ID, null, 1)
  })

  it('announces null when the screen unmounts while I am entering', () => {
    const view = renderSender({ state: 'scanning' })

    view.unmount()

    expect(view.realtime.entryStatus).toHaveBeenLastCalledWith(ROOM_ID, null, 1)
  })

  it('unmounting while I was not entering announces nothing', () => {
    const view = renderSender({ state: null })

    view.unmount()

    expect(view.realtime.entryStatus).not.toHaveBeenCalled()
  })
})

describe('useEntryStatus: heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('repeats a typing status every 15 seconds so the server keeps it alive', () => {
    const view = renderSender({ state: 'typing' })

    act(() => {
      vi.advanceTimersByTime(HEARTBEAT_MS - 1)
    })
    expect(view.realtime.entryStatus).toHaveBeenCalledTimes(1)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(view.realtime.entryStatus).toHaveBeenCalledTimes(2)

    act(() => {
      vi.advanceTimersByTime(HEARTBEAT_MS)
    })
    expect(view.realtime.entryStatus).toHaveBeenCalledTimes(3)
    expect(view.realtime.entryStatus).toHaveBeenLastCalledWith(ROOM_ID, 'typing', 1)
  })

  it('announcing directly sends at once and gives the status its full time from then (X26)', () => {
    const view = renderSender({ state: 'scanning' })
    act(() => {
      vi.advanceTimersByTime(HEARTBEAT_MS - 1)
    })
    view.realtime.entryStatus.mockClear()

    act(() => view.result.current('scanning'))
    expect(view.realtime.entryStatus).toHaveBeenCalledTimes(1)
    expect(view.realtime.entryStatus).toHaveBeenCalledWith(ROOM_ID, 'scanning', 1)

    act(() => {
      vi.advanceTimersByTime(HEARTBEAT_MS - 1)
    })
    expect(view.realtime.entryStatus).toHaveBeenCalledTimes(1)
  })

  it('announcing directly does nothing while I am not entering', () => {
    const view = renderSender({ state: null })

    act(() => view.result.current('scanning'))

    expect(view.realtime.entryStatus).not.toHaveBeenCalled()
  })

  it('stops repeating once I stop entering', () => {
    const view = renderSender({ state: 'typing' })
    view.rerender({ roomId: ROOM_ID, round: 1, state: null })
    view.realtime.entryStatus.mockClear()

    act(() => {
      vi.advanceTimersByTime(HEARTBEAT_MS * 3)
    })

    expect(view.realtime.entryStatus).not.toHaveBeenCalled()
  })

  it('does not repeat anything when I never started entering', () => {
    const view = renderSender({ state: null })

    act(() => {
      vi.advanceTimersByTime(HEARTBEAT_MS * 3)
    })

    expect(view.realtime.entryStatus).not.toHaveBeenCalled()
  })
})

describe('useEntryStatus: reconnects and the camera', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('announces again after the realtime connection is ready, because a restart loses it', () => {
    const view = renderSender({ state: 'scanning' })
    view.realtime.entryStatus.mockClear()

    act(() => view.emitRealtime('ready', { seq: 1 }))

    expect(view.realtime.entryStatus).toHaveBeenCalledTimes(1)
    expect(view.realtime.entryStatus).toHaveBeenCalledWith(ROOM_ID, 'scanning', 1)
  })

  it('stays quiet on ready when I am not entering', () => {
    const view = renderSender({ state: null })

    act(() => view.emitRealtime('ready', { seq: 1 }))

    expect(view.realtime.entryStatus).not.toHaveBeenCalled()
  })

  it('does not clear my status when the page is hidden, because the camera hides it (X26)', () => {
    const view = renderSender({ state: 'scanning' })
    view.realtime.entryStatus.mockClear()

    act(() => setVisibility('hidden'))
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })

    expect(view.realtime.entryStatus).not.toHaveBeenCalledWith(ROOM_ID, null, 1)
  })
})

// --- Seeing who else is entering ---------------------------------------------------------

const PLAYERS = [
  makePlayer('p1', { name: 'Me', turn_order: 0 }),
  makePlayer('p2', { name: 'Sam', turn_order: 1 }),
  makePlayer('p3', { name: 'Jo', turn_order: 2 }),
]

function renderReceiver(props = {}) {
  const initialProps = { roomId: ROOM_ID, round: 1, players: PLAYERS, currentPlayerId: 'p1', ...props }
  return renderGameHook((_fixture, hookProps) => useEnteringPlayers(hookProps), { initialProps })
}

function entryMessage(entries, roomId = ROOM_ID) {
  return { type: 'entry-status', room_id: roomId, entries }
}

function entry(playerId, state, round = 1) {
  return { player_id: playerId, state, round }
}

describe('useEnteringPlayers', () => {
  it('starts with nobody entering', () => {
    const view = renderReceiver()

    expect(view.result.current).toEqual([])
  })

  it('lists the other players the server says are entering', () => {
    const view = renderReceiver()

    act(() => view.emitRealtime('entryStatus', entryMessage([entry('p2', 'scanning')])))

    expect(view.result.current).toEqual([{ id: 'p2', name: 'Sam', state: 'scanning' }])
  })

  it('leaves me out of the list', () => {
    const view = renderReceiver()

    act(() => view.emitRealtime('entryStatus', entryMessage([entry('p1', 'typing'), entry('p3', 'typing')])))

    expect(view.result.current).toEqual([{ id: 'p3', name: 'Jo', state: 'typing' }])
  })

  it('leaves out entries for a different round', () => {
    const view = renderReceiver({ round: 2 })

    act(() => view.emitRealtime('entryStatus', entryMessage([entry('p2', 'typing', 1), entry('p3', 'typing', 2)])))

    expect(view.result.current).toEqual([{ id: 'p3', name: 'Jo', state: 'typing' }])
  })

  it('ignores a message about another room', () => {
    const view = renderReceiver()

    act(() => view.emitRealtime('entryStatus', entryMessage([entry('p2', 'typing')], 'other-room')))

    expect(view.result.current).toEqual([])
  })

  it('each message replaces the last list, and an empty one clears it', () => {
    const view = renderReceiver()
    act(() => view.emitRealtime('entryStatus', entryMessage([entry('p2', 'typing')])))

    act(() => view.emitRealtime('entryStatus', entryMessage([entry('p3', 'scanning')])))
    expect(view.result.current).toEqual([{ id: 'p3', name: 'Jo', state: 'scanning' }])

    act(() => view.emitRealtime('entryStatus', entryMessage([])))
    expect(view.result.current).toEqual([])
  })

  it('stops listening when it unmounts', () => {
    const view = renderReceiver()
    view.unmount()

    expect(() => view.emitRealtime('entryStatus', entryMessage([entry('p2', 'typing')]))).not.toThrow()
  })

  it.each(['reconnecting', 'connecting', 'signed-out'])(
    'shows nobody while my own connection is %s, rather than stale data',
    (status) => {
      const view = renderReceiver()
      act(() => view.emitRealtime('entryStatus', entryMessage([entry('p2', 'typing')])))
      expect(view.result.current).toHaveLength(1)

      view.realtime.getStatus.mockReturnValue(status)
      act(() => view.emitRealtime('status', status))

      expect(view.result.current).toEqual([])
    },
  )

  it('forgets the list on ready, because the server only follows ready with a list that has someone on it', () => {
    const view = renderReceiver()
    act(() => view.emitRealtime('entryStatus', entryMessage([entry('p2', 'typing')])))

    act(() => view.emitRealtime('ready', { seq: 1 }))

    expect(view.result.current).toEqual([])
  })

  it('shows the list again once the connection is live and the server has sent its state', () => {
    const view = renderReceiver()
    view.realtime.getStatus.mockReturnValue('reconnecting')
    act(() => view.emitRealtime('status', 'reconnecting'))

    view.realtime.getStatus.mockReturnValue('live')
    act(() => view.emitRealtime('status', 'live'))
    act(() => view.emitRealtime('entryStatus', entryMessage([entry('p2', 'typing')])))

    expect(view.result.current).toEqual([{ id: 'p2', name: 'Sam', state: 'typing' }])
  })
})
