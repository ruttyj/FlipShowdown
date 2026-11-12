// EmojiAnimation. Fake timers drive framer-motion's exit animations.
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EmojiAnimation, { FULL_EMOJI_DURATION_MS, SMALL_EMOJI_DURATION_MS } from '@/components/game/EmojiAnimation'

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(async () => {
  // Run framer-motion's last scheduled frame before the fake clock goes; a frame left pending
  // on it stalls the animation loop, and so the exit animations, in the next test.
  await act(async () => {
    await vi.runOnlyPendingTimersAsync()
  })
  vi.useRealTimers()
})

async function settle(ms = 2000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function dismiss() {
  await userEvent.click(screen.getByRole('button', { name: 'Dismiss message' }))
  await settle()
}

function forMe(id, emoji, sender, message = '') {
  return { id, emoji, message, sender, senderId: sender, recipients: [{ id: 'me', name: 'You' }], isForMe: true }
}

function between(id, emoji, sender, recipient) {
  return { id, emoji, message: '', sender, senderId: sender, recipients: [{ id: recipient, name: recipient }], isForMe: false }
}

// The Dismiss all and auto-dismiss tests come first on purpose: the last existing test ends with a full-size
// message still mounted, and the infinite framer-motion animation running when the clock
// is restored stalls exit animations in every test that follows it.
// --- Dismiss all (X33) -----------------------------------------------------
// Each item uses a different sender and emoji so enqueueEmoji never merges them.

function dismissAllButton() {
  return screen.getByRole('button', { name: 'Dismiss all' })
}

function queryDismissAllButton() {
  return screen.queryByRole('button', { name: 'Dismiss all' })
}

function focusDismissMessage() {
  act(() => {
    screen.getByRole('button', { name: 'Dismiss message' }).focus()
  })
}

function expectNothingShown() {
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
}

// Renders like the real parent: when the queue reports it is finished, the item is cleared.
function renderWithParent(firstItem) {
  const onClose = vi.fn(() => rerender(<EmojiAnimation onClose={onClose} />))
  const { rerender } = render(<EmojiAnimation item={firstItem} onClose={onClose} />)
  return { onClose, rerender }
}

describe('EmojiAnimation: Dismiss all (X33)', () => {
  // Unmount before the file-level afterEach flushes timers, so a test that fails halfway
  // leaves no mounted animation behind to stall the next test.
  afterEach(() => {
    cleanup()
  })

  it('marks only the full-size overlay, which Layout lifts the toggles above so mute stays tappable (X44)', () => {
    const { unmount } = render(<EmojiAnimation item={between('a', '🎉', 'Sam', 'Alex')} onClose={() => {}} />)
    expect(document.querySelector('[data-full-emoji]')).not.toBeInTheDocument()
    unmount()

    render(<EmojiAnimation item={forMe('b', '🎉', 'Sam')} onClose={() => {}} />)
    expect(screen.getByRole('dialog')).toHaveAttribute('data-full-emoji')
  })

  it('AC1: shows Dismiss all below the message for me while another item waits', () => {
    const { onClose, rerender } = renderWithParent(forMe(1, '🎉', 'Ann', 'Hi'))
    rerender(<EmojiAnimation item={forMe(2, '🔥', 'Bo')} onClose={onClose} />)

    const dialog = screen.getByRole('dialog', { name: 'Message from Ann' })
    const button = within(dialog).getByRole('button', { name: 'Dismiss all' })
    const followsButton = Node.DOCUMENT_POSITION_FOLLOWING

    expect(screen.getByText('1 more')).toBeInTheDocument()
    expect(screen.getByText('🎉').compareDocumentPosition(button) & followsButton).toBeTruthy()
    expect(screen.getByText('1 more').compareDocumentPosition(button) & followsButton).toBeTruthy()
  })

  it('AC2: hides Dismiss all when nothing waits, and a tap still closes the message', async () => {
    const { onClose } = renderWithParent(forMe(1, '🎉', 'Ann', 'Hi'))

    expect(queryDismissAllButton()).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('dialog', { name: 'Message from Ann' }))
    await settle()

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('AC2: hides Dismiss all once a single dismiss leaves nothing waiting', async () => {
    const { onClose, rerender } = renderWithParent(forMe(1, '🎉', 'Ann'))
    rerender(<EmojiAnimation item={forMe(2, '🔥', 'Bo')} onClose={onClose} />)

    await dismiss()

    expect(screen.getByRole('dialog', { name: 'Message from Bo' })).toBeInTheDocument()
    expect(queryDismissAllButton()).not.toBeInTheDocument()
  })

  it('AC3: Dismiss all clears the message on screen and every waiting item, small ones too', async () => {
    const { onClose, rerender } = renderWithParent(forMe(1, '🎉', 'Ann'))
    rerender(<EmojiAnimation item={between(2, '🥶', 'Sam', 'Alex')} onClose={onClose} />)
    rerender(<EmojiAnimation item={forMe(3, '🔥', 'Bo')} onClose={onClose} />)

    expect(screen.getByText('2 more')).toBeInTheDocument()

    await userEvent.click(dismissAllButton())
    await settle()

    expectNothingShown()
    expect(screen.queryByText('🥶')).not.toBeInTheDocument()
    expect(screen.queryByText('🔥')).not.toBeInTheDocument()

    await settle(SMALL_EMOJI_DURATION_MS + 1000)

    expectNothingShown()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('AC4: Dismiss all does not also count as a tap on the overlay', async () => {
    const { onClose, rerender } = renderWithParent(forMe(1, '🎉', 'Ann'))
    rerender(<EmojiAnimation item={forMe(2, '🔥', 'Bo')} onClose={onClose} />)

    await userEvent.click(dismissAllButton())
    await settle()

    expect(screen.queryByRole('dialog', { name: 'Message from Bo' })).not.toBeInTheDocument()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('AC3: a double tap on Dismiss all closes once', async () => {
    const { onClose, rerender } = renderWithParent(forMe(1, '🎉', 'Ann'))
    rerender(<EmojiAnimation item={forMe(2, '🔥', 'Bo')} onClose={onClose} />)
    rerender(<EmojiAnimation item={forMe(3, '❤️', 'Cy')} onClose={onClose} />)

    // Both clicks sit in one act, so the second reaches the same button and handler closure
    // before React re-renders, as a fast real double tap can.
    const button = dismissAllButton()
    act(() => {
      fireEvent.click(button)
      fireEvent.click(button)
    })
    await settle()

    expectNothingShown()
    expect(screen.queryByText('🔥')).not.toBeInTheDocument()
    expect(screen.queryByText('❤️')).not.toBeInTheDocument()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('AC5: a small card never shows Dismiss all; it appears once a message for me is promoted with more waiting', async () => {
    const { onClose, rerender } = renderWithParent(between(1, '🥶', 'Sam', 'Alex'))
    rerender(<EmojiAnimation item={forMe(2, '🎉', 'Ann')} onClose={onClose} />)
    rerender(<EmojiAnimation item={forMe(3, '🔥', 'Bo')} onClose={onClose} />)

    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(queryDismissAllButton()).not.toBeInTheDocument()

    await settle(SMALL_EMOJI_DURATION_MS)
    await settle()

    expect(screen.getByRole('dialog', { name: 'Message from Ann' })).toBeInTheDocument()
    expect(screen.getByText('1 more')).toBeInTheDocument()
    expect(dismissAllButton()).toBeInTheDocument()
  })

  it('AC6: a message arriving after Dismiss all plays normally and no old timer closes it', async () => {
    const { onClose, rerender } = renderWithParent(forMe(1, '🎉', 'Ann'))
    rerender(<EmojiAnimation item={forMe(2, '🔥', 'Bo')} onClose={onClose} />)

    await userEvent.click(dismissAllButton())
    await settle()
    expect(onClose).toHaveBeenCalledTimes(1)

    rerender(<EmojiAnimation item={between(3, '🥶', 'Sam', 'Alex')} onClose={onClose} />)
    expect(screen.getByRole('status')).toHaveTextContent('Sam → Alex')

    await settle(SMALL_EMOJI_DURATION_MS - 500)
    expect(onClose).toHaveBeenCalledTimes(1)

    await settle(1000)
    expect(onClose).toHaveBeenCalledTimes(2)

    await settle(SMALL_EMOJI_DURATION_MS * 2)
    expect(onClose).toHaveBeenCalledTimes(2)

    rerender(<EmojiAnimation item={forMe(4, '❤️', 'Cy')} onClose={onClose} />)
    expect(screen.getByRole('dialog', { name: 'Message from Cy' })).toBeInTheDocument()
  })

  it('AC3: a message arriving while Dismiss all shows is cleared by it too', async () => {
    const { onClose, rerender } = renderWithParent(forMe(1, '🎉', 'Ann'))
    rerender(<EmojiAnimation item={forMe(2, '🔥', 'Bo')} onClose={onClose} />)
    rerender(<EmojiAnimation item={forMe(3, '❤️', 'Cy')} onClose={onClose} />)

    expect(screen.getByText('2 more')).toBeInTheDocument()

    await userEvent.click(dismissAllButton())
    await settle()

    expectNothingShown()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('AC7: Dismiss all is reachable with Tab and works with Enter', async () => {
    const { onClose, rerender } = renderWithParent(forMe(1, '🎉', 'Ann'))
    rerender(<EmojiAnimation item={forMe(2, '🔥', 'Bo')} onClose={onClose} />)

    // Focus the first button explicitly instead of relying on jsdom's autoFocus.
    focusDismissMessage()
    await userEvent.tab()
    expect(dismissAllButton()).toHaveFocus()

    await userEvent.keyboard('{Enter}')
    await settle()

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('AC7: Dismiss all works with Space', async () => {
    const { onClose, rerender } = renderWithParent(forMe(1, '🎉', 'Ann'))
    rerender(<EmojiAnimation item={forMe(2, '🔥', 'Bo')} onClose={onClose} />)

    focusDismissMessage()
    await userEvent.tab()
    expect(dismissAllButton()).toHaveFocus()

    await userEvent.keyboard(' ')
    await settle()

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('AC7: Escape still dismisses only the message on screen while Dismiss all shows', async () => {
    const { onClose, rerender } = renderWithParent(forMe(1, '🎉', 'Ann'))
    rerender(<EmojiAnimation item={forMe(2, '🔥', 'Bo')} onClose={onClose} />)
    rerender(<EmojiAnimation item={forMe(3, '❤️', 'Cy')} onClose={onClose} />)

    act(() => {
      dismissAllButton().focus()
    })
    await userEvent.keyboard('{Escape}')
    await settle()

    expect(screen.getByRole('dialog', { name: 'Message from Bo' })).toBeInTheDocument()
    expect(screen.getByText('1 more')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('AC8: tapping the overlay still dismisses one item while Dismiss all shows', async () => {
    const { onClose, rerender } = renderWithParent(forMe(1, '🎉', 'Ann'))
    rerender(<EmojiAnimation item={forMe(2, '🔥', 'Bo')} onClose={onClose} />)

    await userEvent.click(screen.getByRole('dialog', { name: 'Message from Ann' }))
    await settle()

    expect(screen.getByRole('dialog', { name: 'Message from Bo' })).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('AC5, AC8: tapping a small card still dismisses one item and shows no Dismiss all', async () => {
    const { onClose, rerender } = renderWithParent(between(1, '🥶', 'Sam', 'Alex'))
    rerender(<EmojiAnimation item={between(2, '❤️', 'Cy', 'Dee')} onClose={onClose} />)

    await userEvent.click(within(screen.getByRole('status')).getByRole('button'))
    await settle()

    expect(screen.getByRole('status')).toHaveTextContent('Cy → Dee')
    expect(onClose).not.toHaveBeenCalled()
    expect(queryDismissAllButton()).not.toBeInTheDocument()
  })

  it('AC6: a message with the same id as a cleared one still plays after Dismiss all', async () => {
    const { onClose, rerender } = renderWithParent(forMe(1, '🎉', 'Ann'))
    rerender(<EmojiAnimation item={forMe(2, '🔥', 'Bo')} onClose={onClose} />)

    await userEvent.click(dismissAllButton())
    await settle()
    expect(onClose).toHaveBeenCalledTimes(1)
    expectNothingShown()

    // Same id as the cleared Bo: it must not be dropped as a duplicate of the last item seen.
    rerender(<EmojiAnimation item={forMe(2, '🔥', 'Bo')} onClose={onClose} />)

    expect(screen.getByRole('dialog', { name: 'Message from Bo' })).toBeInTheDocument()
  })
})

// --- Full-size auto-dismiss (X35) ----------------------------------------------

describe('EmojiAnimation: full-size auto-dismiss (X35)', () => {
  afterEach(() => {
    cleanup()
  })

  it('a message for me dances for a short while, then goes away on its own', async () => {
    const { onClose } = renderWithParent(forMe(1, '🎉', 'Ann', 'Hi'))

    await settle(FULL_EMOJI_DURATION_MS - 500)
    expect(screen.getByRole('dialog', { name: 'Message from Ann' })).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()

    await settle(1000)
    await settle()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('moves on to the next waiting message by itself, each getting its full time', async () => {
    const { onClose, rerender } = renderWithParent(forMe(1, '🎉', 'Ann'))
    rerender(<EmojiAnimation item={forMe(2, '🔥', 'Bo')} onClose={onClose} />)

    // Bo's own timer starts when Ann leaves, while her exit animation plays.
    await settle(FULL_EMOJI_DURATION_MS)
    await settle()
    expect(screen.getByRole('dialog', { name: 'Message from Bo' })).toBeInTheDocument()

    await settle(FULL_EMOJI_DURATION_MS - 2500)
    expect(screen.getByRole('dialog', { name: 'Message from Bo' })).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()

    await settle(1000)
    await settle()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a tap before the time is up dismisses once, and the old timer does not skip the next one', async () => {
    const { onClose, rerender } = renderWithParent(forMe(1, '🎉', 'Ann'))
    rerender(<EmojiAnimation item={forMe(2, '🔥', 'Bo')} onClose={onClose} />)

    // Tap 1.5 s before Ann's time is up; dismiss() then waits 2 s, past where her timer would fire.
    await settle(FULL_EMOJI_DURATION_MS - 1500)
    await dismiss()

    expect(screen.getByRole('dialog', { name: 'Message from Bo' })).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('keeps the same overlay from one message for me to the next, so the background never flashes', async () => {
    const { onClose, rerender } = renderWithParent(forMe(1, '🎉', 'Ann'))
    rerender(<EmojiAnimation item={forMe(2, '🔥', 'Bo')} onClose={onClose} />)
    const overlay = screen.getByRole('dialog', { name: 'Message from Ann' })

    // Mid-swap the overlay is still there while the old emoji leaves.
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss message' }))
    expect(screen.getByRole('dialog')).toBe(overlay)

    await settle()
    expect(screen.getByRole('dialog', { name: 'Message from Bo' })).toBe(overlay)
    expect(screen.getByText('🔥')).toBeInTheDocument()
    expect(screen.queryByText('🎉')).not.toBeInTheDocument()
  })

  it('scales the emoji with the screen instead of a fixed pixel size', () => {
    renderWithParent(forMe(1, '🎉', 'Ann'))

    expect(screen.getByText('🎉').className).toMatch(/vmin/)
  })
})

describe('EmojiAnimation', () => {
  it('plays queued items one at a time and closes after the last', async () => {
    const first = forMe(1, '🎉', 'Ann', 'Hi')
    const second = forMe(2, '🔥', 'Bo')
    // Like the real parent, clear the props when the queue reports it is finished.
    const onClose = vi.fn(() => rerender(<EmojiAnimation onClose={onClose} />))
    const { rerender } = render(<EmojiAnimation item={first} onClose={onClose} />)
    rerender(<EmojiAnimation item={second} onClose={onClose} />)

    expect(screen.getByRole('dialog', { name: 'Message from Ann' })).toBeInTheDocument()
    expect(screen.getByText('Ann → You')).toBeInTheDocument()
    expect(screen.getByText('🎉')).toBeInTheDocument()
    expect(screen.queryByText('🔥')).not.toBeInTheDocument()
    expect(screen.getByText('1 more')).toBeInTheDocument()

    await dismiss()

    expect(screen.getByRole('dialog', { name: 'Message from Bo' })).toBeInTheDocument()
    expect(screen.getByText('🔥')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()

    await dismiss()

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not queue the same message twice when props repeat', async () => {
    const onClose = vi.fn(() => rerender(<EmojiAnimation onClose={onClose} />))
    const item = forMe(1, '🎉', 'Ann', 'Hi')
    const { rerender } = render(<EmojiAnimation item={item} onClose={onClose} />)
    rerender(<EmojiAnimation item={{ ...item }} onClose={onClose} />)

    expect(screen.queryByText(/more/)).not.toBeInTheDocument()
    await dismiss()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a message between others plays small with a caption and fades on its own', async () => {
    const onClose = vi.fn(() => rerender(<EmojiAnimation onClose={onClose} />))
    const { rerender } = render(<EmojiAnimation item={between(1, '🥶', 'Sam', 'Alex')} onClose={onClose} />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Sam → Alex')
    expect(screen.getByText('🥶')).toBeInTheDocument()

    await settle(SMALL_EMOJI_DURATION_MS - 500)
    expect(onClose).not.toHaveBeenCalled()

    await settle(1000)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('a message for me waits behind a small one, then plays full size', async () => {
    const onClose = vi.fn(() => rerender(<EmojiAnimation onClose={onClose} />))
    const { rerender } = render(<EmojiAnimation item={between(1, '🥶', 'You', 'Alex')} onClose={onClose} />)
    rerender(<EmojiAnimation item={forMe(2, '🤬', 'Alex')} onClose={onClose} />)

    expect(screen.getByRole('status')).toHaveTextContent('You → Alex')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await settle(SMALL_EMOJI_DURATION_MS)
    await settle()

    expect(screen.getByRole('dialog', { name: 'Message from Alex' })).toBeInTheDocument()
  })
})
