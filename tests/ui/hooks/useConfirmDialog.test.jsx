// useConfirmDialog.
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useConfirmDialog } from '@/pages/gameRoom/useConfirmDialog'

describe('useConfirmDialog', () => {
  it('starts closed', () => {
    const view = renderHook(() => useConfirmDialog())

    expect(view.result.current.confirmDialog.open).toBe(false)
  })

  it('confirm opens the dialog and resolves true on confirm', async () => {
    const view = renderHook(() => useConfirmDialog())

    let answer
    act(() => {
      answer = view.result.current.confirm({ title: 'Sure?' })
    })
    expect(view.result.current.confirmDialog).toMatchObject({ open: true, title: 'Sure?' })

    await act(async () => {
      view.result.current.confirmDialog.onConfirm()
      await answer
    })

    await expect(answer).resolves.toBe(true)
  })

  it('confirm resolves false on cancel; ask distinguishes cancel from dismiss', async () => {
    const view = renderHook(() => useConfirmDialog())

    let cancelled
    act(() => {
      cancelled = view.result.current.confirm({ title: 'A' })
    })
    await act(async () => {
      view.result.current.confirmDialog.onCancel()
      await cancelled
    })
    await expect(cancelled).resolves.toBe(false)

    let asked
    act(() => {
      asked = view.result.current.ask({ title: 'B' })
    })
    const { confirmDialog } = view.result.current
    await act(async () => {
      confirmDialog.onOpenChange(false)
      await asked
    })
    await expect(asked).resolves.toBe('dismiss')
    expect(view.result.current.confirmDialog.open).toBe(false)
  })

  it('opening a dialog over another dismisses the first', async () => {
    const view = renderHook(() => useConfirmDialog())

    let first
    let second
    act(() => {
      first = view.result.current.ask({ title: 'First' })
    })
    act(() => {
      second = view.result.current.ask({ title: 'Second' })
    })

    await expect(first).resolves.toBe('dismiss')
    expect(view.result.current.confirmDialog).toMatchObject({ open: true, title: 'Second' })

    await act(async () => {
      view.result.current.confirmDialog.onConfirm()
      await second
    })
    await expect(second).resolves.toBe('confirm')
  })

  it('a late close for an answered dialog does not dismiss the next one', async () => {
    const view = renderHook(() => useConfirmDialog())

    let first
    act(() => {
      first = view.result.current.ask({ title: 'First' })
    })
    const staleDialog = view.result.current.confirmDialog
    await act(async () => {
      staleDialog.onConfirm()
      await first
    })

    let second
    act(() => {
      second = view.result.current.ask({ title: 'Second' })
    })
    act(() => {
      staleDialog.onOpenChange(false)
    })

    expect(view.result.current.confirmDialog).toMatchObject({ open: true, title: 'Second' })
    await act(async () => {
      view.result.current.confirmDialog.onCancel()
      await second
    })
  })
})
