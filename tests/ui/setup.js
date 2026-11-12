// Shared setup for the Vitest suite (tests/ui/). jsdom lacks several browser APIs the app
// uses; the stubs below give every test the same inert, predictable versions. A test that
// needs different behaviour overrides one with vi.spyOn or vi.stubGlobal.
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// --- matchMedia ------------------------------------------------------------
// Every query reports "no match", like a plain desktop browser with default settings.

function createMediaQueryList(query) {
  return {
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false
    },
  }
}

function installMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: createMediaQueryList,
  })
}

// --- IntersectionObserver --------------------------------------------------
// Observes nothing and never calls back, so nothing ever counts as scrolled into view.

class StubIntersectionObserver {
  constructor(callback, options = {}) {
    this.callback = callback
    this.root = options.root ?? null
    this.rootMargin = options.rootMargin ?? '0px'
    this.thresholds = [].concat(options.threshold ?? 0)
  }

  observe() {}

  unobserve() {}

  disconnect() {}

  takeRecords() {
    return []
  }
}

function installIntersectionObserver() {
  window.IntersectionObserver = StubIntersectionObserver
  globalThis.IntersectionObserver = StubIntersectionObserver
}

// --- ResizeObserver --------------------------------------------------------
// Radix measures a popover's anchor with it. Nothing is laid out, so it never calls back.

class StubResizeObserver {
  observe() {}

  unobserve() {}

  disconnect() {}
}

function installResizeObserver() {
  window.ResizeObserver = StubResizeObserver
  globalThis.ResizeObserver = StubResizeObserver
}

// --- Element scrolling -----------------------------------------------------
// jsdom has no layout, so it leaves out scrollTo and scrollIntoView. They do nothing here.

function installElementScrolling() {
  Element.prototype.scrollTo = function scrollTo() {}
  Element.prototype.scrollIntoView = function scrollIntoView() {}
}

// --- navigator.wakeLock ----------------------------------------------------
// request() always succeeds and resolves to a sentinel that can be released once. Anything
// rendering Layout requests the lock on mount, through useKeepScreenOn.

function createWakeLockSentinel(type) {
  return {
    type,
    released: false,
    onrelease: null,
    async release() {
      this.released = true
    },
    addEventListener() {},
    removeEventListener() {},
  }
}

function installWakeLock() {
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: {
      async request(type = 'screen') {
        return createWakeLockSentinel(type)
      },
    },
  })
}

// --- BroadcastChannel ------------------------------------------------------
// In-memory channels: a message posted on one instance reaches every other open instance
// with the same name (never the sender), asynchronously, as in a browser. Channels are
// closed after each test so nothing leaks between tests.

const openChannels = new Set()

class StubBroadcastChannel extends EventTarget {
  constructor(name) {
    super()
    this.name = String(name)
    this.onmessage = null
    this.closed = false
    openChannels.add(this)
  }

  postMessage(data) {
    if (this.closed) {
      throw new DOMException('BroadcastChannel is closed', 'InvalidStateError')
    }

    for (const channel of openChannels) {
      const isReceiver = channel !== this && channel.name === this.name
      if (isReceiver) {
        queueMicrotask(() => channel.deliver(data))
      }
    }
  }

  // Runs on the receiving channel; skips delivery if it closed while the message was queued.
  deliver(data) {
    if (this.closed) {
      return
    }

    const event = new MessageEvent('message', { data })
    this.dispatchEvent(event)
    if (typeof this.onmessage === 'function') {
      this.onmessage(event)
    }
  }

  close() {
    this.closed = true
    openChannels.delete(this)
  }
}

function closeAllChannels() {
  for (const channel of openChannels) {
    channel.close()
  }
}

function installBroadcastChannel() {
  window.BroadcastChannel = StubBroadcastChannel
  globalThis.BroadcastChannel = StubBroadcastChannel
}

// --- Install ---------------------------------------------------------------

// --- Canvas ----------------------------------------------------------------
// jsdom has no canvas: getContext logs "not implemented" and returns null. The logo then falls
// back to its default fit (src/lib/logoFit.js); this keeps that quiet.

function installCanvas() {
  HTMLCanvasElement.prototype.getContext = () => null
}

installMatchMedia()
installCanvas()
installIntersectionObserver()
installResizeObserver()
installElementScrolling()
installWakeLock()
installBroadcastChannel()

afterEach(() => {
  cleanup()
  closeAllChannels()
  localStorage.clear()
  sessionStorage.clear()
})
