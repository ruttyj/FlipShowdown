// SoundToggle: its title follows the muted state and a click calls onToggle.
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import SoundToggle from '@/components/game/SoundToggle'

describe('SoundToggle', () => {
  it('offers to mute while sound is on, and calls onToggle', () => {
    const onToggle = vi.fn()
    render(<SoundToggle isMuted={false} onToggle={onToggle} />)

    fireEvent.click(screen.getByRole('button', { name: 'Mute sounds' }))

    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('offers to unmute while muted', () => {
    render(<SoundToggle isMuted onToggle={() => {}} />)

    expect(screen.getByRole('button', { name: 'Unmute sounds' })).toHaveAttribute('aria-label', 'Unmute sounds')
  })
})
