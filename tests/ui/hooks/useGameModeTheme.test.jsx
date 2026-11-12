// useGameModeTheme: which mode the screen shows, and the timing of the shift between modes (X41).
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useGameModeTheme } from '@/hooks/useGameModeTheme'

const ROOM = 'room-1'
const COVER_MS = 400
const FADE_MS = 400

function renderTheme(initialProps = { roomId: ROOM, mode: 'classic' }) {
  return renderHook((props) => useGameModeTheme(props), { initialProps })
}

function themeAttribute() {
  return document.documentElement.getAttribute('data-game-mode')
}

function stubReducedMotion() {
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }))
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the attribute on <html>', () => {
  it('follows the room with no shift on first load', () => {
    const view = renderTheme({ roomId: ROOM, mode: 'vengeance' })

    expect(themeAttribute()).toBe('vengeance')
    expect(view.result.current.themeMode).toBe('vengeance')
    expect(view.result.current.modeShift).toBeNull()
  })

  it('stays neutral until the room has loaded, then applies with no shift', () => {
    const view = renderTheme({ roomId: null, mode: null })
    expect(themeAttribute()).toBeNull()

    view.rerender({ roomId: ROOM, mode: 'vengeance' })

    expect(themeAttribute()).toBe('vengeance')
    expect(view.result.current.modeShift).toBeNull()
  })

  it('is removed on unmount, so leaving a room does not leave Home red', () => {
    const view = renderTheme({ roomId: ROOM, mode: 'vengeance' })

    view.unmount()

    expect(themeAttribute()).toBeNull()
  })

  it('is removed when the room goes away', () => {
    const view = renderTheme({ roomId: ROOM, mode: 'vengeance' })

    view.rerender({ roomId: null, mode: null })

    expect(themeAttribute()).toBeNull()
  })

  it('moving to another room shows its mode with no shift', () => {
    const view = renderTheme({ roomId: ROOM, mode: 'classic' })

    view.rerender({ roomId: 'room-2', mode: 'vengeance' })

    expect(themeAttribute()).toBe('vengeance')
    expect(view.result.current.modeShift).toBeNull()
  })

  it('a refetch with the same mode does nothing', () => {
    const view = renderTheme({ roomId: ROOM, mode: 'vengeance' })

    view.rerender({ roomId: ROOM, mode: 'vengeance' })

    expect(view.result.current.modeShift).toBeNull()
  })
})

describe('the shift', () => {
  it('starts on a real change, and hides the swap until the circle has covered the screen', () => {
    const view = renderTheme()

    view.rerender({ roomId: ROOM, mode: 'vengeance' })
    expect(view.result.current.modeShift).toMatchObject({ to: 'vengeance' })
    expect(view.result.current.modeShift.coverMs).toBe(COVER_MS)
    expect(view.result.current.modeShift.fadeMs).toBe(FADE_MS)
    expect(view.result.current.modeShift.isCrossFade).toBe(false)
    expect(themeAttribute()).toBe('classic')
    expect(view.result.current.themeMode).toBe('classic')

    act(() => vi.advanceTimersByTime(COVER_MS))
    expect(themeAttribute()).toBe('vengeance')
    expect(view.result.current.themeMode).toBe('vengeance')
    expect(view.result.current.modeShift).not.toBeNull()

    act(() => vi.advanceTimersByTime(FADE_MS))
    expect(view.result.current.modeShift).toBeNull()
  })

  it('a second change during a shift jumps to the newest mode and restarts', () => {
    const view = renderTheme()
    view.rerender({ roomId: ROOM, mode: 'vengeance' })
    const firstShift = view.result.current.modeShift

    act(() => vi.advanceTimersByTime(COVER_MS / 2))
    view.rerender({ roomId: ROOM, mode: 'classic' })

    expect(view.result.current.modeShift.to).toBe('classic')
    expect(view.result.current.modeShift.id).not.toBe(firstShift.id)

    // The first shift's timers are gone: nothing happens when it would have covered.
    act(() => vi.advanceTimersByTime(COVER_MS / 2))
    expect(view.result.current.modeShift.to).toBe('classic')

    act(() => vi.advanceTimersByTime(COVER_MS + FADE_MS))
    expect(themeAttribute()).toBe('classic')
    expect(view.result.current.modeShift).toBeNull()
  })

  it('leaving the room cancels it and removes the attribute', () => {
    const view = renderTheme()
    view.rerender({ roomId: ROOM, mode: 'vengeance' })

    view.unmount()
    act(() => vi.advanceTimersByTime(COVER_MS))

    expect(themeAttribute()).toBeNull()
  })

  it('a tab in the background skips it and just shows the new mode', () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    const view = renderTheme()

    view.rerender({ roomId: ROOM, mode: 'vengeance' })

    expect(view.result.current.modeShift).toBeNull()
    expect(themeAttribute()).toBe('vengeance')
  })

  it('under reduced motion it is a 200 ms cross-fade', () => {
    stubReducedMotion()
    const view = renderTheme()

    view.rerender({ roomId: ROOM, mode: 'vengeance' })
    expect(view.result.current.modeShift).toMatchObject({ coverMs: 100, fadeMs: 100, isCrossFade: true })

    act(() => vi.advanceTimersByTime(100))
    expect(themeAttribute()).toBe('vengeance')

    act(() => vi.advanceTimersByTime(100))
    expect(view.result.current.modeShift).toBeNull()
  })
})
