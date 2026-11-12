// useKeepScreenOn: holds a Screen Wake Lock for as long as it is mounted, with no preference
// and no UI (X28). Where the API is missing or the lock is denied, play simply carries on.
import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useKeepScreenOn } from '@/hooks/useKeepScreenOn'

// --- Helpers ---------------------------------------------------------------------

function makeSentinel() {
  const releaseListeners = []
  return {
    release: vi.fn().mockResolvedValue(undefined),
    addEventListener: (_type, listener) => releaseListeners.push(listener),
    // What the browser does when it drops the lock, e.g. when the page is hidden.
    dropByBrowser: () => {
      for (const listener of releaseListeners) {
        listener()
      }
    },
  }
}

function setVisibility(state) {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state)
  document.dispatchEvent(new Event('visibilitychange'))
}

/** A wake lock request the test settles by hand. */
function makePendingRequest() {
  const pending = {}
  pending.promise = new Promise((resolve) => {
    pending.resolve = resolve
  })
  return pending
}

async function flushPromises() {
  await act(async () => {})
}

// --- Holding the lock ------------------------------------------------------------

test('requests the screen lock on mount', async () => {
  const request = vi.spyOn(navigator.wakeLock, 'request')

  renderHook(() => useKeepScreenOn())

  await waitFor(() => expect(request).toHaveBeenCalledWith('screen'))
})

test('ignores the old flip7_wake_lock preference: players who turned it off get it back on', async () => {
  localStorage.setItem('flip7_wake_lock', 'false')
  const request = vi.spyOn(navigator.wakeLock, 'request')

  renderHook(() => useKeepScreenOn())

  await waitFor(() => expect(request).toHaveBeenCalledTimes(1))
})

test('re-acquires when the page becomes visible after the browser dropped the lock', async () => {
  const first = makeSentinel()
  const second = makeSentinel()
  const request = vi.spyOn(navigator.wakeLock, 'request')
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(second)
  renderHook(() => useKeepScreenOn())
  await flushPromises()

  first.dropByBrowser()
  setVisibility('hidden')
  await flushPromises()
  expect(request).toHaveBeenCalledTimes(1)

  setVisibility('visible')
  await flushPromises()

  expect(request).toHaveBeenCalledTimes(2)
})

test('does not request a second lock on becoming visible while it still holds one', async () => {
  const request = vi.spyOn(navigator.wakeLock, 'request').mockResolvedValue(makeSentinel())
  renderHook(() => useKeepScreenOn())
  await flushPromises()

  setVisibility('visible')
  await flushPromises()

  expect(request).toHaveBeenCalledTimes(1)
})

test('releases the lock and stops listening on unmount', async () => {
  const sentinel = makeSentinel()
  const request = vi.spyOn(navigator.wakeLock, 'request').mockResolvedValue(sentinel)
  const view = renderHook(() => useKeepScreenOn())
  await flushPromises()

  view.unmount()
  expect(sentinel.release).toHaveBeenCalledTimes(1)

  setVisibility('visible')
  await flushPromises()
  expect(request).toHaveBeenCalledTimes(1)
})

test('a release that fails on unmount is swallowed', async () => {
  const sentinel = makeSentinel()
  sentinel.release.mockRejectedValue(new Error('already released'))
  vi.spyOn(navigator.wakeLock, 'request').mockResolvedValue(sentinel)
  const view = renderHook(() => useKeepScreenOn())
  await flushPromises()

  view.unmount()
  await flushPromises()

  expect(sentinel.release).toHaveBeenCalledTimes(1)
})

test('forgets a dropped lock so unmounting does not release it again', async () => {
  const sentinel = makeSentinel()
  vi.spyOn(navigator.wakeLock, 'request').mockResolvedValue(sentinel)
  const view = renderHook(() => useKeepScreenOn())
  await flushPromises()

  sentinel.dropByBrowser()
  view.unmount()

  expect(sentinel.release).not.toHaveBeenCalled()
})

// --- Races -----------------------------------------------------------------------

test('a lock granted after unmount is released straight away', async () => {
  const pending = makePendingRequest()
  vi.spyOn(navigator.wakeLock, 'request').mockReturnValue(pending.promise)
  const view = renderHook(() => useKeepScreenOn())

  view.unmount()
  const sentinel = makeSentinel()
  pending.resolve(sentinel)
  await flushPromises()

  expect(sentinel.release).toHaveBeenCalledTimes(1)
})

test('when two requests race, the second lock granted is released and the first kept', async () => {
  const firstRequest = makePendingRequest()
  const secondRequest = makePendingRequest()
  vi.spyOn(navigator.wakeLock, 'request')
    .mockReturnValueOnce(firstRequest.promise)
    .mockReturnValueOnce(secondRequest.promise)
  renderHook(() => useKeepScreenOn())

  setVisibility('visible')
  const first = makeSentinel()
  const second = makeSentinel()
  firstRequest.resolve(first)
  secondRequest.resolve(second)
  await flushPromises()

  expect(first.release).not.toHaveBeenCalled()
  expect(second.release).toHaveBeenCalledTimes(1)
})

// --- When there is no lock to be had ---------------------------------------------

test('a denied lock changes nothing, and is retried the next time the page is visible', async () => {
  const request = vi.spyOn(navigator.wakeLock, 'request')
    .mockRejectedValueOnce(new DOMException('Low battery', 'NotAllowedError'))
    .mockResolvedValueOnce(makeSentinel())
  renderHook(() => useKeepScreenOn())
  await flushPromises()
  expect(request).toHaveBeenCalledTimes(1)

  setVisibility('visible')
  await flushPromises()

  expect(request).toHaveBeenCalledTimes(2)
})

test('does nothing in a browser without the API, as on plain HTTP', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'wakeLock')
  delete navigator.wakeLock
  const addListener = vi.spyOn(document, 'addEventListener')
  try {
    const view = renderHook(() => useKeepScreenOn())
    await flushPromises()

    expect(addListener).not.toHaveBeenCalledWith('visibilitychange', expect.anything())
    expect(() => view.unmount()).not.toThrow()
  } finally {
    Object.defineProperty(navigator, 'wakeLock', descriptor)
  }
})
