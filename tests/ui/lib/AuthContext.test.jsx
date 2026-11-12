// AuthProvider's auth check, logout and login redirect, and useAuth's guard.
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backend } from '@/api/backend'
import { AuthProvider, useAuth } from '@/lib/AuthContext'

vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))

function renderAuth() {
  return renderHook(() => useAuth(), { wrapper: AuthProvider })
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

describe('AuthProvider', () => {
  beforeEach(() => {
    backend.auth.me.mockReset()
    backend.auth.logout.mockReset()
    backend.auth.redirectToLogin.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('signs in the account the server reports', async () => {
    backend.auth.me.mockResolvedValue({ id: 'u1' })

    const view = renderAuth()

    await waitFor(() => expect(view.result.current.isLoadingAuth).toBe(false))
    expect(view.result.current.user).toEqual({ id: 'u1' })
    expect(view.result.current.isAuthenticated).toBe(true)
    expect(view.result.current.authError).toBeNull()
  })

  it.each([401, 403])('treats a %i as signed out, not as an error', async (status) => {
    backend.auth.me.mockRejectedValue(httpError(status, 'no'))

    const view = renderAuth()

    await waitFor(() => expect(view.result.current.isLoadingAuth).toBe(false))
    expect(view.result.current.isAuthenticated).toBe(false)
    expect(view.result.current.authError).toBeNull()
  })

  it('reports any other failure as an auth error with its message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    backend.auth.me.mockRejectedValue(httpError(500, 'server exploded'))

    const view = renderAuth()

    await waitFor(() => expect(view.result.current.authError).toEqual({ type: 'unknown', message: 'server exploded' }))
  })

  it('falls back to a generic message when the failure has none', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    backend.auth.me.mockRejectedValue(httpError(500, ''))

    const view = renderAuth()

    await waitFor(() => expect(view.result.current.authError?.message).toBe('Failed to load app'))
  })

  it('logout clears the user and redirects back to this page by default', async () => {
    backend.auth.me.mockResolvedValue({ id: 'u1' })
    const view = renderAuth()
    await waitFor(() => expect(view.result.current.isAuthenticated).toBe(true))

    act(() => view.result.current.logout())

    expect(view.result.current.user).toBeNull()
    expect(view.result.current.isAuthenticated).toBe(false)
    expect(backend.auth.logout).toHaveBeenCalledWith(window.location.href)
  })

  it('logout(false) signs out without a redirect', async () => {
    backend.auth.me.mockResolvedValue({ id: 'u1' })
    const view = renderAuth()
    await waitFor(() => expect(view.result.current.isAuthenticated).toBe(true))

    act(() => view.result.current.logout(false))

    expect(backend.auth.logout).toHaveBeenCalledWith()
  })

  it('navigateToLogin sends the visitor to login and back to this page', async () => {
    backend.auth.me.mockResolvedValue(null)
    const view = renderAuth()
    await waitFor(() => expect(view.result.current.isLoadingAuth).toBe(false))

    act(() => view.result.current.navigateToLogin())

    expect(backend.auth.redirectToLogin).toHaveBeenCalledWith(window.location.href)
  })
})

describe('useAuth', () => {
  it('throws outside an AuthProvider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => renderHook(() => useAuth())).toThrow('useAuth must be used within an AuthProvider')
  })
})
