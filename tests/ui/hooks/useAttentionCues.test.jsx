// useAttentionCues.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAttentionCues } from '@/hooks/useAttentionCues'
import { VIBRATION_PATTERNS } from '@/lib/attentionCues'

function setVisibility(state) {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state)
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

beforeEach(() => {
  document.title = 'Flip 7'
  navigator.vibrate = vi.fn()
})

afterEach(() => {
  vi.restoreAllMocks()
  delete navigator.vibrate
})

describe('useAttentionCues', () => {
  it('prefixes the title while hidden and restores it when visible', () => {
    const view = renderHook(() => useAttentionCues())
    setVisibility('hidden')

    act(() => view.result.current('turn', 'Your turn'))
    expect(document.title).toBe('• Your turn — Flip 7')

    setVisibility('visible')
    expect(document.title).toBe('Flip 7')
  })

  it('does not stack prefixes on repeated cues', () => {
    const view = renderHook(() => useAttentionCues())
    setVisibility('hidden')

    act(() => view.result.current('turn', 'One'))
    act(() => view.result.current('turn', 'Two'))

    expect(document.title).toBe('• Two — Flip 7')
  })

  it('leaves the title alone while visible', () => {
    const view = renderHook(() => useAttentionCues())

    act(() => view.result.current('turn', 'Your turn'))

    expect(document.title).toBe('Flip 7')
  })

  it('vibrates only for important kinds', () => {
    const view = renderHook(() => useAttentionCues())

    act(() => view.result.current('turn', 'x'))
    expect(navigator.vibrate).toHaveBeenLastCalledWith(VIBRATION_PATTERNS.turn)
    act(() => view.result.current('gameStart', 'x'))
    expect(navigator.vibrate).toHaveBeenLastCalledWith(VIBRATION_PATTERNS.gameStart)
    act(() => view.result.current('gameEnd', 'x'))
    expect(navigator.vibrate).toHaveBeenLastCalledWith(VIBRATION_PATTERNS.gameEnd)

    navigator.vibrate.mockClear()
    act(() => view.result.current('chat', 'x'))
    expect(navigator.vibrate).not.toHaveBeenCalled()
  })

  it('does not throw when vibration is unsupported', () => {
    delete navigator.vibrate
    const view = renderHook(() => useAttentionCues())

    expect(() => act(() => view.result.current('turn', 'x'))).not.toThrow()
  })

  it('restores the title on unmount', () => {
    const view = renderHook(() => useAttentionCues())
    setVisibility('hidden')
    act(() => view.result.current('turn', 'Your turn'))

    view.unmount()

    expect(document.title).toBe('Flip 7')
  })

  it('stays quiet when becoming visible with no cue', () => {
    renderHook(() => useAttentionCues())
    document.title = 'Other'

    setVisibility('visible')

    expect(document.title).toBe('Other')
  })
})
