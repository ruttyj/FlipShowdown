import { afterEach, describe, expect, it, vi } from 'vitest'
import { keepAtTop, keepInClearView } from '@/lib/keepInClearView'

function stubRect(element, top, bottom) {
  element.getBoundingClientRect = () => ({ top, bottom })
}

// A scrolling list holding a panel with a sticky footer and the button being kept in view.
function makePage({ buttonBottom, footerTop = null }) {
  const container = document.createElement('div')
  container.style.overflowY = 'auto'
  const panel = document.createElement('section')
  const button = document.createElement('button')
  stubRect(button, buttonBottom - 40, buttonBottom)
  panel.append(button)
  if (footerTop !== null) {
    const footer = document.createElement('div')
    footer.setAttribute('data-sticky-footer', '')
    stubRect(footer, footerTop, footerTop + 80)
    panel.append(footer)
  }
  container.append(panel)
  document.body.append(container)
  return { container, button }
}

function stubVisualViewport(height, offsetTop = 0) {
  const listeners = new Set()
  vi.stubGlobal('visualViewport', {
    height,
    offsetTop,
    addEventListener: (_, listener) => listeners.add(listener),
    removeEventListener: (_, listener) => listeners.delete(listener),
  })
  return { resize: () => listeners.forEach((listener) => listener()), listeners }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

function scrollAfterDelay(button) {
  vi.useFakeTimers()
  keepInClearView(button)
  vi.advanceTimersByTime(200)
}

describe('keepInClearView', () => {
  it('scrolls a button under the sticky footer just clear of it, with a small gap', () => {
    stubVisualViewport(800)
    const { container, button } = makePage({ buttonBottom: 700, footerTop: 600 })

    scrollAfterDelay(button)

    expect(container.scrollTop).toBe(112)
  })

  it('scrolls a button under the keyboard clear of the keyboard', () => {
    stubVisualViewport(400, 50)
    const { container, button } = makePage({ buttonBottom: 500 })

    scrollAfterDelay(button)

    expect(container.scrollTop).toBe(62)
  })

  it('leaves a button already in clear view alone', () => {
    stubVisualViewport(800)
    const { container, button } = makePage({ buttonBottom: 300, footerTop: 600 })

    scrollAfterDelay(button)

    expect(container.scrollTop).toBe(0)
  })

  it('uses the window height where there is no visual viewport', () => {
    vi.stubGlobal('visualViewport', undefined)
    vi.stubGlobal('innerHeight', 500)
    const { container, button } = makePage({ buttonBottom: 520 })

    scrollAfterDelay(button)

    expect(container.scrollTop).toBe(32)
  })

  it('does nothing without a button', () => {
    expect(() => keepInClearView(null)()).not.toThrow()
  })

  it('measures again when the keyboard finishes opening', () => {
    const viewport = stubVisualViewport(800)
    const { container, button } = makePage({ buttonBottom: 700 })
    keepInClearView(button)
    expect(container.scrollTop).toBe(0)

    vi.stubGlobal('visualViewport', { ...globalThis.visualViewport, height: 400 })
    viewport.resize()

    expect(container.scrollTop).toBe(312)
  })

  it('stops following the viewport once things have settled, or when stopped', () => {
    vi.useFakeTimers()
    const viewport = stubVisualViewport(800)
    const { button } = makePage({ buttonBottom: 100 })

    keepInClearView(button)
    vi.advanceTimersByTime(1000)
    expect(viewport.listeners.size).toBe(0)

    const stop = keepInClearView(button)
    expect(viewport.listeners.size).toBe(1)
    stop()
    expect(viewport.listeners.size).toBe(0)
  })
})

describe('keepAtTop', () => {
  it('scrolls to the top now and again as the keyboard opens, until things settle (X56)', () => {
    vi.useFakeTimers()
    const viewport = stubVisualViewport(800)
    const { container, button } = makePage({ buttonBottom: 700 })
    container.scrollTo = vi.fn()

    keepAtTop(button)
    expect(container.scrollTo).toHaveBeenCalledTimes(1)

    viewport.resize()
    expect(container.scrollTo).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(1000)
    expect(viewport.listeners.size).toBe(0)
  })

  it('does nothing without an element', () => {
    expect(() => keepAtTop(null)()).not.toThrow()
  })
})

describe('keepInClearView timing (X57)', () => {
  it('waits for the new row to show before it scrolls', () => {
    vi.useFakeTimers()
    stubVisualViewport(800)
    const { container, button } = makePage({ buttonBottom: 700, footerTop: 600 })

    keepInClearView(button)
    expect(container.scrollTop).toBe(0)

    vi.advanceTimersByTime(200)
    expect(container.scrollTop).toBe(112)
  })

  it('does not scroll at all when stopped before the delay ends', () => {
    vi.useFakeTimers()
    stubVisualViewport(800)
    const { container, button } = makePage({ buttonBottom: 700, footerTop: 600 })

    const stop = keepInClearView(button)
    stop()
    vi.advanceTimersByTime(1000)

    expect(container.scrollTop).toBe(0)
  })
})
