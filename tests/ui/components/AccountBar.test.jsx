// AccountBar: signed-in name and email with log out, and a sign-in button when signed out.
// (There is no name editing in AccountBar.)
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AccountBar from '@/components/AccountBar'
import { fakeBackend, resetFakeApi } from '../fixtures/fakeApi.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

describe('AccountBar', () => {
  it('shows the full name and email, and logs out to the home page', () => {
    resetFakeApi()
    render(<AccountBar user={{ email: 'p1@example.com', full_name: 'Player One' }} />)

    expect(screen.getByText('Player One')).toBeInTheDocument()
    expect(screen.getByText('p1@example.com')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /log out/i }))

    expect(fakeBackend.auth.logout).toHaveBeenCalledWith('/')
    expect(screen.getByRole('button', { name: /log out/i })).toBeDisabled()
  })

  it('falls back to the email prefix when there is no full name', () => {
    resetFakeApi()
    render(<AccountBar user={{ email: 'sam@example.com' }} />)

    expect(screen.getByText('sam')).toBeInTheDocument()
  })

  it('offers sign in when signed out, returning to the current page', () => {
    resetFakeApi()
    render(<AccountBar user={null} />)

    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))

    expect(fakeBackend.auth.redirectToLogin).toHaveBeenCalledWith(window.location.href)
  })
})
