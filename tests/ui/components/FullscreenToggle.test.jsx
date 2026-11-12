// FullscreenToggle: hidden where the Fullscreen API is missing (iPhone Safari); otherwise it
// enters/exits fullscreen and follows the `fullscreenchange` event.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FullscreenToggle from '@/components/game/FullscreenToggle'

function stubFullscreenApi() {
  let current = null
  document.documentElement.requestFullscreen = vi.fn(async () => {
    current = document.documentElement
  })
  document.exitFullscreen = vi.fn(async () => {
    current = null
  })
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => current,
  })
}

function removeFullscreenApi() {
  delete document.documentElement.requestFullscreen
  delete document.exitFullscreen
  delete document.fullscreenElement
}

describe('FullscreenToggle', () => {
  afterEach(() => {
    removeFullscreenApi()
  })

  it('is hidden when the Fullscreen API is missing', () => {
    render(<FullscreenToggle />)

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('enters fullscreen on tap and flips its label on fullscreenchange', async () => {
    stubFullscreenApi()
    render(<FullscreenToggle />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enter full screen' }))
    })
    expect(document.documentElement.requestFullscreen).toHaveBeenCalled()

    act(() => {
      document.dispatchEvent(new Event('fullscreenchange'))
    })
    expect(screen.getByRole('button', { name: 'Exit full screen' })).toHaveAttribute('title', 'Exit full screen')
  })

  it('exits fullscreen when already fullscreen', async () => {
    stubFullscreenApi()
    render(<FullscreenToggle />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enter full screen' }))
    })
    act(() => {
      document.dispatchEvent(new Event('fullscreenchange'))
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Exit full screen' }))
    })
    act(() => {
      document.dispatchEvent(new Event('fullscreenchange'))
    })

    expect(document.exitFullscreen).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Enter full screen' })).toBeInTheDocument()
  })
})
