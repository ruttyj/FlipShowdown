// DuplicateTabNotice: shown when the same room is open in another tab, and dismissible.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import DuplicateTabNotice from '@/components/DuplicateTabNotice'

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('DuplicateTabNotice', () => {
  it('shows nothing when the room is open in one tab only', async () => {
    render(<DuplicateTabNotice roomId="room-1" />)
    await settle()

    expect(screen.queryByText(/open in another tab/i)).not.toBeInTheDocument()
  })

  it('shows the notice when a second tab opens the same room, and OK dismisses it', async () => {
    render(<DuplicateTabNotice roomId="room-1" />)
    render(<DuplicateTabNotice roomId="room-1" />)
    await settle()

    const notices = screen.getAllByText(/open in another tab/i)
    expect(notices).toHaveLength(2)

    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0])

    expect(screen.getAllByText(/open in another tab/i)).toHaveLength(1)
  })

  it('ignores a tab with a different room', async () => {
    render(<DuplicateTabNotice roomId="room-1" />)
    render(<DuplicateTabNotice roomId="room-2" />)
    await settle()

    expect(screen.queryByText(/open in another tab/i)).not.toBeInTheDocument()
  })
})
