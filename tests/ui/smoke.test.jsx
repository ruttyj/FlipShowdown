// Proves the Vitest setup works: JSX compiles through the React plugin, the "@/" alias
// resolves, Testing Library renders into jsdom, and the jest-dom matchers are installed.
import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { cn } from '@/lib/utils'

test('renders JSX and resolves a module through the @/ alias', () => {
  render(<p className={cn('base', 'extra')}>Hello Flip 7</p>)

  const paragraph = screen.getByText('Hello Flip 7')
  expect(paragraph).toBeInTheDocument()
  expect(paragraph).toHaveClass('base', 'extra')
})

test('provides the browser API stubs from setup.js', async () => {
  const sentinel = await navigator.wakeLock.request('screen')

  expect(window.matchMedia('(min-width: 600px)').matches).toBe(false)
  expect(typeof IntersectionObserver).toBe('function')
  expect(sentinel.released).toBe(false)
  expect(typeof BroadcastChannel).toBe('function')
})
