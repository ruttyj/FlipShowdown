import React from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ScoreEntryPanel from '@/components/game/ScoreEntryPanel'
import CardScanner from '@/components/game/CardScanner'
import ManualScoreEntry from '@/components/game/ManualScoreEntry'
import { SoundProvider } from '@/components/useSound'
import { scrollToTop } from '@/lib/scrollToTop'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/lib/scrollToTop', () => ({ scrollToTop: vi.fn() }))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

const MODELS = [{ id: 'flash', display_name: 'Flash' }]

beforeEach(() => {
  vi.mocked(scrollToTop).mockClear()
})

const scrolledElements = () => vi.mocked(scrollToTop).mock.calls.map(([element]) => element)

function renderScanner(props = {}) {
  render(
    <SoundProvider>
      <CardScanner
        aiEnabled
        modelList={MODELS}
        onCardsConfirmed={vi.fn()}
        onCancel={vi.fn()}
        onManualEntry={vi.fn()}
        setCurrentModel={vi.fn()}
        {...props}
      />
    </SoundProvider>,
  )
}

function renderManual(props = {}) {
  render(<ManualScoreEntry onScoreConfirmed={vi.fn()} onCancel={vi.fn()} {...props} />)
}

describe('ScoreEntryPanel', () => {
  it('puts Back and the title in the header and calls onBack', async () => {
    const onBack = vi.fn()
    render(<ScoreEntryPanel title="Scan Cards" onBack={onBack}>body</ScoreEntryPanel>)

    const panel = screen.getByRole('region', { name: 'Scan Cards' })
    await userEvent.click(within(panel).getByRole('button', { name: 'Back' }))

    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('disables Back while the score is being sent', () => {
    render(<ScoreEntryPanel title="Scan Cards" onBack={vi.fn()} backDisabled>body</ScoreEntryPanel>)

    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
  })

  it('scrolls the whole panel into view when it opens', () => {
    render(<ScoreEntryPanel title="Scan Cards" onBack={vi.fn()}>body</ScoreEntryPanel>)

    expect(scrolledElements()).toEqual([screen.getByRole('region', { name: 'Scan Cards' })])
  })

  // X56: on a phone the keyboard opening interrupts the smooth scroll and leaves the panel part way.
  describe('while the keyboard opens (X56)', () => {
    let viewport

    beforeEach(() => {
      viewport = new EventTarget()
      vi.stubGlobal('visualViewport', viewport)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('scrolls to the top again when the keyboard shrinks the screen', () => {
      render(<ScoreEntryPanel title="Enter Cards" onBack={vi.fn()}>body</ScoreEntryPanel>)
      const panel = screen.getByRole('region', { name: 'Enter Cards' })

      viewport.dispatchEvent(new Event('resize'))

      expect(scrolledElements()).toEqual([panel, panel])
    })

    it('stops following once the panel is gone', () => {
      const { unmount } = render(<ScoreEntryPanel title="Enter Cards" onBack={vi.fn()}>body</ScoreEntryPanel>)
      unmount()
      vi.mocked(scrollToTop).mockClear()

      viewport.dispatchEvent(new Event('resize'))

      expect(scrolledElements()).toEqual([])
    })
  })

  it('keeps a gap above the panel when scrolled to, clear of the safe area', () => {
    render(<ScoreEntryPanel title="Scan Cards" onBack={vi.fn()}>body</ScoreEntryPanel>)

    expect(screen.getByRole('region', { name: 'Scan Cards' }).className).toContain('scroll-mt-')
  })
})

describe('score entry panels share one layout', () => {
  it.each([
    ['the scanner', renderScanner, 'Scan Cards'],
    ['manual entry', renderManual, 'Enter Cards'],
  ])('%s opens in the shared panel with Back in its header', (_name, renderPanel, title) => {
    renderPanel()

    const panel = screen.getByRole('region', { name: title })
    expect(within(panel).getByRole('button', { name: 'Back' })).toBeInTheDocument()
    expect(scrolledElements()[0]).toBe(panel)
  })

  it.each([
    ['the scanner', renderScanner, 'Scan Cards'],
    ['manual entry', renderManual, 'Enter Cards'],
  ])('%s disables Back while submitting', (_name, renderPanel) => {
    renderPanel({ isSubmitting: true })

    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
  })

  it('scanner Retake scrolls the panel back to the top', async () => {
    renderScanner({ initialCards: [{ type: 'number', value: '5' }] })
    vi.mocked(scrollToTop).mockClear()

    await userEvent.click(screen.getByRole('button', { name: /retake photo/i }))

    expect(scrolledElements()).toContain(screen.getByRole('region', { name: 'Scan Cards' }))
  })
})
