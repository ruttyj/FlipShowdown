// PageNotFound names the missing page, shows the admin note to admins, and links home.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { backend } from '@/api/backend'
import PageNotFound from '@/lib/PageNotFound'

vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/Missing']}>
        <PageNotFound />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const ADMIN_NOTE = /Admin Note/

describe('PageNotFound', () => {
  beforeEach(() => {
    backend.auth.me.mockReset()
  })

  it('names the page that was not found', async () => {
    backend.auth.me.mockResolvedValue({ role: 'user' })

    renderPage()

    expect(screen.getByRole('heading', { name: 'Page Not Found' })).toBeInTheDocument()
    expect(screen.getByText('"Missing"')).toBeInTheDocument()
    await waitFor(() => expect(backend.auth.me).toHaveBeenCalled())
    expect(screen.queryByText(ADMIN_NOTE)).not.toBeInTheDocument()
  })

  it('shows the admin note to a signed-in admin', async () => {
    backend.auth.me.mockResolvedValue({ role: 'admin' })

    renderPage()

    expect(await screen.findByText(ADMIN_NOTE)).toBeInTheDocument()
  })

  it('hides the admin note when signed out', async () => {
    backend.auth.me.mockRejectedValue(new Error('401'))

    renderPage()

    await waitFor(() => expect(backend.auth.me).toHaveBeenCalled())
    expect(screen.queryByText(ADMIN_NOTE)).not.toBeInTheDocument()
  })

  it('Go Home sends the browser to the root', () => {
    backend.auth.me.mockResolvedValue({ role: 'user' })
    const location = { href: '/Missing' }
    vi.stubGlobal('location', location)
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: /go home/i }))

    expect(location.href).toBe('/')
  })
})
