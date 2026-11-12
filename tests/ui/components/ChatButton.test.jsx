// ChatButton: one tap, a double tap, and the pulse wave on every tap (X79).
import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatButton, { DOUBLE_TAP_MS } from '@/components/game/ChatButton'

function renderButton(props = {}) {
  const onTap = vi.fn()
  const onDoubleTap = vi.fn()
  const view = render(<ChatButton onTap={onTap} onDoubleTap={onDoubleTap} isOpen={false} isExpanded={false} {...props} />)
  return { onTap, onDoubleTap, view, button: screen.getByRole('button', { name: 'Chat' }) }
}

function tap(button) {
  act(() => {
    fireEvent.click(button)
  })
}

describe('ChatButton: taps (X79)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    act(() => {
      vi.runOnlyPendingTimers()
    })
    vi.useRealTimers()
  })

  it('one tap calls onTap once the double-tap window has passed', () => {
    const { onTap, onDoubleTap, button } = renderButton()

    tap(button)
    expect(onTap).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(DOUBLE_TAP_MS)
    })
    expect(onTap).toHaveBeenCalledTimes(1)
    expect(onDoubleTap).not.toHaveBeenCalled()
  })

  it('two quick taps call onDoubleTap and never onTap', () => {
    const { onTap, onDoubleTap, button } = renderButton()

    tap(button)
    act(() => {
      vi.advanceTimersByTime(DOUBLE_TAP_MS - 50)
    })
    tap(button)
    act(() => {
      vi.advanceTimersByTime(DOUBLE_TAP_MS * 2)
    })

    expect(onDoubleTap).toHaveBeenCalledTimes(1)
    expect(onTap).not.toHaveBeenCalled()
  })

  it('two slow taps are two single taps', () => {
    const { onTap, onDoubleTap, button } = renderButton()

    tap(button)
    act(() => {
      vi.advanceTimersByTime(DOUBLE_TAP_MS + 10)
    })
    tap(button)
    act(() => {
      vi.advanceTimersByTime(DOUBLE_TAP_MS + 10)
    })

    expect(onTap).toHaveBeenCalledTimes(2)
    expect(onDoubleTap).not.toHaveBeenCalled()
  })

  it('a tap waiting when the button goes away never fires', () => {
    const { onTap, button, view } = renderButton()

    tap(button)
    view.unmount()
    act(() => {
      vi.advanceTimersByTime(DOUBLE_TAP_MS * 2)
    })

    expect(onTap).not.toHaveBeenCalled()
  })

  it('sends a pulse wave out on every tap, and each wave goes when its animation ends', () => {
    const { button } = renderButton()
    expect(screen.queryAllByTestId('chat-button-pulse')).toHaveLength(0)

    tap(button)
    tap(button)
    const waves = screen.getAllByTestId('chat-button-pulse')
    expect(waves).toHaveLength(2)

    // jsdom has no AnimationEvent, so React listens for the prefixed name there (see ChatMuteToggle.test).
    fireEvent(waves[0], new Event('webkitAnimationEnd', { bubbles: true }))
    expect(screen.getAllByTestId('chat-button-pulse')).toHaveLength(1)
  })

  it('says whether the quick sends are showing', () => {
    renderButton({ isExpanded: true })

    expect(screen.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-expanded', 'true')
  })
})
