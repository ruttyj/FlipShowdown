// OfflineBadge and its helpers.
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import OfflineBadge, { isPlayerOnline } from '@/components/game/OfflineBadge'

describe('OfflineBadge', () => {
  it('renders the offline label', () => {
    render(<OfflineBadge />)

    expect(screen.getByText('offline')).toBeInTheDocument()
  })

  it('treats me as online even when my presence lags', () => {
    expect(isPlayerOnline({ online: false }, true)).toBe(true)
    expect(isPlayerOnline({ online: false }, false)).toBe(false)
    expect(isPlayerOnline({ online: true }, false)).toBe(true)
  })
})
