// Toaster: the fixed toast containers must not swallow taps while empty (X16), and a shown
// toast and its close button must stay interactive.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster } from '@/components/ui/toaster'
import { toast } from '@/components/ui/use-toast'

function getContainers(container) {
  const fixedElements = container.querySelectorAll('.fixed')
  return Array.from(fixedElements)
}

describe('Toaster', () => {
  it('lets taps pass through the empty viewport and its provider wrapper', () => {
    const { container } = render(<Toaster />)

    const containers = getContainers(container)

    expect(containers.length).toBeGreaterThan(0)
    for (const element of containers) {
      expect(element.className).toContain('pointer-events-none')
    }
  })

  it('keeps a shown toast clickable, with a working close button', () => {
    const onClick = vi.fn()
    const { container } = render(<Toaster />)

    act(() => {
      toast({ title: 'Saved', description: 'All good' })
    })

    const toastElement = screen.getByText('Saved').closest('.group')
    expect(toastElement.className).toContain('pointer-events-auto')

    const closeButton = container.querySelector('[toast-close]')
    closeButton.addEventListener('click', onClick)
    fireEvent.click(closeButton)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  describe('dismissal (X-host toast refused to go away)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('auto-dismisses and removes a toast after the default duration', () => {
      render(<Toaster />)

      act(() => {
        toast({ title: 'Sam is now the host' })
      })
      expect(screen.getByText('Sam is now the host')).toBeTruthy()

      act(() => {
        vi.advanceTimersByTime(6000)
      })
      expect(screen.queryByText('Sam is now the host')).toBeNull()
    })

    it('dismisses a toast when it is tapped anywhere', () => {
      render(<Toaster />)

      act(() => {
        toast({ title: 'Tap me' })
      })
      fireEvent.click(screen.getByText('Tap me'))

      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(screen.queryByText('Tap me')).toBeNull()
    })

    it('gives toasts a frosted-glass style', () => {
      render(<Toaster />)

      act(() => {
        toast({ title: 'Glass' })
      })

      const toastElement = screen.getByText('Glass').closest('.group')
      expect(toastElement.className).toContain('backdrop-blur')
    })
  })
})
