// ChatMuteToggle: its name follows the muted state, a click toggles, and the quiet pulse ring
// runs once per pulse key and then leaves nothing behind (X44).
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import ChatMuteToggle from '@/components/game/ChatMuteToggle'

const RING_SELECTOR = '[data-testid="chat-mute-pulse"]'

function findRing() {
  return document.querySelector(RING_SELECTOR)
}

// jsdom has no AnimationEvent, so React listens for the prefixed event name there instead of
// animationend, and fireEvent.animationEnd never reaches onAnimationEnd.
function finishAnimation(element) {
  fireEvent(element, new Event('webkitAnimationEnd', { bubbles: true }))
}

function renderToggle(props = {}) {
  const allProps = { isMuted: true, onToggle: () => {}, pulseKey: 0, ...props }
  const view = render(<ChatMuteToggle {...allProps} />)
  const setPulseKey = (pulseKey) => view.rerender(<ChatMuteToggle {...allProps} pulseKey={pulseKey} />)
  return { setPulseKey }
}

// --- Button ----------------------------------------------------------------------

test('offers to mute while chat is on, and a click toggles', () => {
  const onToggle = vi.fn()
  renderToggle({ isMuted: false, onToggle })

  const button = screen.getByRole('button', { name: 'Mute chat' })
  expect(button).toHaveAttribute('title', 'Mute chat')
  expect(button.querySelector('.lucide-message-circle')).toBeInTheDocument()

  fireEvent.click(button)
  expect(onToggle).toHaveBeenCalledTimes(1)
})

test('offers to unmute while muted, with the crossed-out icon', () => {
  renderToggle({ isMuted: true })

  const button = screen.getByRole('button', { name: 'Unmute chat' })
  expect(button).toHaveAttribute('title', 'Unmute chat')
  expect(button.querySelector('.lucide-message-circle-off')).toBeInTheDocument()
})

// --- Pulse -----------------------------------------------------------------------

test('shows no ring until a pulse arrives', () => {
  renderToggle()

  expect(findRing()).not.toBeInTheDocument()
})

test('a pulse draws a quiet ring that switches to the single fade under reduced motion', () => {
  const { setPulseKey } = renderToggle()

  setPulseKey(1)

  const ring = findRing()
  expect(ring).toHaveClass('animate-chat-mute-pulse', 'motion-reduce:animate-chat-mute-fade')
  expect(ring).toHaveClass('pointer-events-none')
  expect(ring).toHaveAttribute('aria-hidden', 'true')
  expect(ring).not.toHaveAttribute('aria-live')
  expect(ring).toHaveTextContent('')
})

test('the ring goes away when its animation ends: no badge, count or anything to clear', () => {
  const { setPulseKey } = renderToggle()
  setPulseKey(1)

  finishAnimation(findRing())

  expect(findRing()).not.toBeInTheDocument()
})

test('a new message restarts the pulse with a fresh element rather than stacking', () => {
  const { setPulseKey } = renderToggle()
  setPulseKey(1)
  const firstRing = findRing()

  setPulseKey(2)

  expect(document.querySelectorAll(RING_SELECTOR)).toHaveLength(1)
  expect(findRing()).not.toBe(firstRing)
})

test('a new message after the ring ended pulses again', () => {
  const { setPulseKey } = renderToggle()
  setPulseKey(1)
  finishAnimation(findRing())

  setPulseKey(2)

  expect(findRing()).toBeInTheDocument()
})

test('tapping the button stops a running pulse', () => {
  const { setPulseKey } = renderToggle()
  setPulseKey(1)

  fireEvent.click(screen.getByRole('button', { name: 'Unmute chat' }))

  expect(findRing()).not.toBeInTheDocument()
})

test('coming back to a room does not replay a pulse from before', () => {
  renderToggle({ pulseKey: 3 })

  expect(findRing()).not.toBeInTheDocument()
})
