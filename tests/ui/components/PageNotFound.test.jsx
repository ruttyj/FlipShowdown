// PageNotFound: names the missing page and shows the admin note only to admins.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import PageNotFound from '@/lib/PageNotFound'
import { resetFakeApi } from '../fixtures/fakeApi.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

function renderNotFound(user) {
  resetFakeApi({ user })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/Nowhere']}>
        <PageNotFound />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('PageNotFound', () => {
  it('renders the 404 with the page name and a Go Home button', () => {
    renderNotFound(null)

    expect(screen.getByRole('heading', { name: 'Page Not Found' })).toBeInTheDocument()
    expect(screen.getByText(/"Nowhere"/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /go home/i })).toBeInTheDocument()
    expect(screen.queryByText('Admin Note')).not.toBeInTheDocument()
  })

  it('shows the admin note to an admin', async () => {
    renderNotFound({ id: 'a', email: 'a@example.com', role: 'admin' })

    expect(await screen.findByText('Admin Note')).toBeInTheDocument()
  })

  it('hides the admin note from a regular user', async () => {
    renderNotFound({ id: 'u', email: 'u@example.com', role: 'user' })

    await screen.findByRole('heading', { name: 'Page Not Found' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByText('Admin Note')).not.toBeInTheDocument()
  })
})
