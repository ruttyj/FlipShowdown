// useActionRunner.
import { act, renderHook } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useActionRunner } from '@/pages/gameRoom/useActionRunner'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

function deferred() {
  let resolve
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('useActionRunner', () => {
  it('busy[name] is true while running and false after', async () => {
    const refetch = vi.fn()
    const view = renderHook(() => useActionRunner({ refetch }))
    const pending = deferred()

    let performed
    act(() => {
      performed = view.result.current.perform('kick', 'Kick', () => pending.promise)
    })
    expect(view.result.current.busy.kick).toBe(true)

    await act(async () => {
      pending.resolve('done')
      await performed
    })

    expect(view.result.current.busy.kick).toBe(false)
    await expect(performed).resolves.toBe('done')
  })

  it('shows a toast on failure, resolves undefined and does not refetch', async () => {
    const refetch = vi.fn()
    const view = renderHook(() => useActionRunner({ refetch }))

    let result
    await act(async () => {
      result = await view.result.current.perform('kick', 'Kick', () => Promise.reject(new Error('nope')))
    })

    expect(result).toBeUndefined()
    expect(toast.error).toHaveBeenCalledWith('Kick failed: nope')
    expect(refetch).not.toHaveBeenCalled()
    expect(view.result.current.busy.kick).toBe(false)
  })

  it('refetches after a success unless refetchAfter is false', async () => {
    const refetch = vi.fn()
    const view = renderHook(() => useActionRunner({ refetch }))

    await act(async () => {
      await view.result.current.perform('a', 'A', async () => 1, { refetchAfter: false })
    })
    expect(refetch).not.toHaveBeenCalled()

    await act(async () => {
      await view.result.current.perform('a', 'A', async () => 1)
    })
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('ignores a second call to the same action while it is running', async () => {
    const view = renderHook(() => useActionRunner({ refetch: vi.fn() }))
    const pending = deferred()
    const second = vi.fn()

    let first
    let ignored
    act(() => {
      first = view.result.current.perform('kick', 'Kick', () => pending.promise)
      ignored = view.result.current.perform('kick', 'Kick', second)
    })

    await expect(ignored).resolves.toBeUndefined()
    expect(second).not.toHaveBeenCalled()

    await act(async () => {
      pending.resolve('ok')
      await first
    })

    // Free again afterwards.
    await act(async () => {
      await view.result.current.perform('kick', 'Kick', second)
    })
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('tracks different actions independently', async () => {
    const view = renderHook(() => useActionRunner({ refetch: vi.fn() }))
    const pending = deferred()

    let first
    act(() => {
      first = view.result.current.perform('kick', 'Kick', () => pending.promise)
    })
    await act(async () => {
      await view.result.current.perform('start', 'Start', async () => 1)
    })

    expect(view.result.current.busy).toEqual({ kick: true, start: false })

    await act(async () => {
      pending.resolve()
      await first
    })
  })

  it('stays silent for a signed-out (401) failure', async () => {
    const view = renderHook(() => useActionRunner({ refetch: vi.fn() }))
    const error = Object.assign(new Error('unauthorized'), { status: 401 })

    await act(async () => {
      await view.result.current.perform('kick', 'Kick', () => Promise.reject(error))
    })

    expect(toast.error).not.toHaveBeenCalled()
  })
})
