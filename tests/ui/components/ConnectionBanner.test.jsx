// ConnectionBanner: hidden while live, "Reconnecting" only after the delay, and a
// signed-out prompt.
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ConnectionBanner from '@/components/ConnectionBanner'
import { RECONNECT_DELAY_MS } from '@/lib/connectionBanner'
import { emitRealtime, fakeRealtime, resetFakeApi } from '../fixtures/fakeApi.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

function renderBanner(initialStatus) {
  resetFakeApi()
  fakeRealtime.getStatus.mockReturnValue(initialStatus)
  return render(<ConnectionBanner />)
}

function changeStatus(status) {
  fakeRealtime.getStatus.mockReturnValue(status)
  act(() => {
    emitRealtime('status', status)
  })
}

describe('ConnectionBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows nothing visible while the connection is live', () => {
    renderBanner('live')

    expect(screen.queryByText(/reconnecting/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('shows Reconnecting only after the delay since going down', () => {
    renderBanner('live')

    changeStatus('reconnecting')
    expect(screen.queryByText(/reconnecting/i)).not.toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(RECONNECT_DELAY_MS + 50)
    })
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument()
  })

  it('hides the banner again once live returns', () => {
    renderBanner('live')
    changeStatus('reconnecting')
    act(() => {
      vi.advanceTimersByTime(RECONNECT_DELAY_MS + 50)
    })

    changeStatus('live')

    expect(screen.queryByText(/reconnecting/i)).not.toBeInTheDocument()
  })

  it('offers to continue when signed out, reloading the page on tap', () => {
    const reload = vi.fn()
    const original = window.location
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, reload } })
    try {
      renderBanner('live')

      changeStatus('signed-out')
      screen.getByRole('button', { name: /signed out/i }).click()

      expect(reload).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original })
    }
  })

  it('shows no bar when the page loads already signed out', () => {
    renderBanner('signed-out')

    expect(screen.queryByRole('button', { name: /signed out/i })).not.toBeInTheDocument()
  })

  it('shows the bar when the connection goes live and then the session is lost', () => {
    renderBanner('live')

    changeStatus('signed-out')

    expect(screen.getByRole('button', { name: /signed out/i })).toBeInTheDocument()
  })
})
