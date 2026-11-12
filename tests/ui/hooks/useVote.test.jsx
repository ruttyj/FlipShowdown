// useVote.
import { act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useVote } from '@/hooks/useVote'
import { renderGameHook, ROOM_ID } from '../fixtures/renderGameHook.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

const TOPIC = 'host'

function renderVote(handlers = {}) {
  return renderGameHook(() => useVote(ROOM_ID, TOPIC, handlers))
}

function setVisibility(state) {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state)
  document.dispatchEvent(new Event('visibilitychange'))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('hold and release', () => {
  it('hold sends voteHold', () => {
    const view = renderVote()

    act(() => view.result.current.hold('p2'))

    expect(view.realtime.voteHold).toHaveBeenCalledWith(ROOM_ID, TOPIC, 'p2')
  })

  it('release sends voteRelease only if this instance holds', () => {
    const view = renderVote()

    act(() => view.result.current.release())
    expect(view.realtime.voteRelease).not.toHaveBeenCalled()

    act(() => view.result.current.hold('p2'))
    act(() => view.result.current.release())
    act(() => view.result.current.release())

    expect(view.realtime.voteRelease).toHaveBeenCalledTimes(1)
    expect(view.realtime.voteRelease).toHaveBeenCalledWith(ROOM_ID, TOPIC)
  })

  it('one button unmounting does not release a hold made through another', () => {
    const buttonA = renderVote()
    const buttonB = renderVote()
    act(() => buttonB.result.current.hold('p3'))

    buttonA.unmount()

    expect(buttonA.realtime.voteRelease).not.toHaveBeenCalled()
  })

  it('unmounting while holding releases', () => {
    const view = renderVote()
    act(() => view.result.current.hold('p2'))

    view.unmount()

    expect(view.realtime.voteRelease).toHaveBeenCalledTimes(1)
  })
})

describe('page lifecycle', () => {
  it('hiding the page while holding releases', () => {
    const view = renderVote()
    act(() => view.result.current.hold('p2'))

    act(() => setVisibility('hidden'))

    expect(view.realtime.voteRelease).toHaveBeenCalledTimes(1)
  })

  it('becoming visible does not release', () => {
    const view = renderVote()
    act(() => view.result.current.hold('p2'))

    act(() => setVisibility('visible'))

    expect(view.realtime.voteRelease).not.toHaveBeenCalled()
  })

  it('pagehide releases', () => {
    const view = renderVote()
    act(() => view.result.current.hold('p2'))

    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })

    expect(view.realtime.voteRelease).toHaveBeenCalledTimes(1)
  })

  it('a reconnect while still holding re-sends the hold', () => {
    const view = renderVote()
    act(() => view.result.current.hold('p2'))
    view.realtime.voteHold.mockClear()

    act(() => view.emitRealtime('ready'))

    expect(view.realtime.voteHold).toHaveBeenCalledWith(ROOM_ID, TOPIC, 'p2')
  })

  it('a reconnect after release sends nothing', () => {
    const view = renderVote()
    act(() => view.result.current.hold('p2'))
    act(() => view.result.current.release())
    view.realtime.voteHold.mockClear()

    act(() => view.emitRealtime('ready'))

    expect(view.realtime.voteHold).not.toHaveBeenCalled()
  })
})

describe('callbacks', () => {
  it('onPassed and onError fire for this room and topic only', () => {
    const onPassed = vi.fn()
    const onError = vi.fn()
    const view = renderVote({ onPassed, onError })

    act(() => {
      view.emitRealtime('vote', { type: 'vote-passed', room_id: ROOM_ID, topic: TOPIC, option: 'p2' })
      view.emitRealtime('vote', { type: 'vote-error', room_id: ROOM_ID, topic: TOPIC, code: 'bad' })
      view.emitRealtime('vote', { type: 'vote-passed', room_id: 'other', topic: TOPIC, option: 'p9' })
      view.emitRealtime('vote', { type: 'vote-passed', room_id: ROOM_ID, topic: 'other', option: 'p9' })
      view.emitRealtime('vote', { type: 'vote-error', room_id: 'other', topic: TOPIC, code: 'x' })
    })

    expect(onPassed).toHaveBeenCalledTimes(1)
    expect(onPassed).toHaveBeenCalledWith('p2')
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('bad')
  })

  it('works without callbacks', () => {
    const view = renderVote()

    act(() => {
      view.emitRealtime('vote', { type: 'vote-passed', room_id: ROOM_ID, topic: TOPIC, option: 'p2' })
    })

    expect(view.result.current.voteState).toBeNull()
  })
})
