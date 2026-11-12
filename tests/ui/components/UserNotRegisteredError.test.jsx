// UserNotRegisteredError renders its explanation.
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import UserNotRegisteredError from '@/components/UserNotRegisteredError'

describe('UserNotRegisteredError', () => {
  it('tells the user access is restricted and what to do', () => {
    render(<UserNotRegisteredError />)

    expect(screen.getByRole('heading', { name: 'Access Restricted' })).toBeInTheDocument()
    expect(screen.getByText(/not registered to use this application/i)).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })
})
