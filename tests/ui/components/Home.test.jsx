// Home page: create / join, the create-after-login return, the max-score input and
// "Return to game". Rendered with the fixture's fake API and the app's providers.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { toast } from 'sonner'
import { describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '@/lib/AuthContext'
import { UNOFFICIAL_DISCLAIMER } from '@/lib/disclaimer'
import Home from '@/pages/Home'
import { DEFAULT_USER, ROOM_CODE } from '../fixtures/renderGameHook.jsx'
import { fakeBackend, fakeGame, resetFakeApi } from '../fixtures/fakeApi.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

const LAST_ROOM_KEY = 'flip7_last_room'

function LocationProbe() {
  const location = useLocation()
  return <output aria-label="current location">{location.pathname + location.search}</output>
}

/** Renders Home at `url` (also written to window.location, which Home reads). */
function renderHome({ url = '/', user = DEFAULT_USER, game = {} } = {}) {
  resetFakeApi({ game, user })
  window.history.replaceState(null, '', url)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  const tree = (
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[url]}>
          <Home />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthProvider>
  )
  const view = render(tree)
  return { ...view, rerenderHome: () => view.rerender(tree) }
}

function findCreateButton() {
  return screen.findByRole('button', { name: /create room/i })
}

function currentLocation() {
  return screen.getByLabelText('current location').textContent
}

function createdRoom() {
  return async () => ({ room: { code: ROOM_CODE } })
}

/** The settings gear, found by its accessible name (X11). */
async function openSettings() {
  await findCreateButton()
  fireEvent.click(screen.getByRole('button', { name: 'Game settings' }))
  return screen.findByLabelText(/max score/i)
}

describe('Home: create room', () => {
  it('signed in: creates the room with the default max score and opens it', async () => {
    renderHome({ game: { createRoom: createdRoom() } })

    fireEvent.click(await findCreateButton())

    await waitFor(() => expect(currentLocation()).toBe(`/room/${ROOM_CODE}`))
    expect(fakeGame.createRoom).toHaveBeenCalledWith({ max_score: 200, game_mode: 'classic' })
  })

  it('signed in: creates the room with the chosen max score', async () => {
    renderHome({ game: { createRoom: createdRoom() } })

    fireEvent.change(await openSettings(), { target: { value: '150' } })
    fireEvent.click(screen.getByRole('button', { name: /create room/i }))

    await waitFor(() => expect(fakeGame.createRoom).toHaveBeenCalledWith({ max_score: 150, game_mode: 'classic' }))
  })

  it('signed out: redirects to login with create=1 and the max score', async () => {
    renderHome({ user: null })

    fireEvent.change(await openSettings(), { target: { value: '150' } })
    fireEvent.click(screen.getByRole('button', { name: /create room/i }))

    expect(fakeBackend.auth.redirectToLogin).toHaveBeenCalledWith(
      `${window.location.origin}/Home?create=1&max_score=150&game_mode=classic`,
    )
    expect(fakeGame.createRoom).not.toHaveBeenCalled()
  })
})

describe('Home: max-score input (X7)', () => {
  it.each(['-5', '0'])('sends 200 when %s is entered', async (entered) => {
    renderHome({ game: { createRoom: createdRoom() } })

    fireEvent.change(await openSettings(), { target: { value: entered } })
    fireEvent.click(screen.getByRole('button', { name: /create room/i }))

    await waitFor(() => expect(fakeGame.createRoom).toHaveBeenCalledWith({ max_score: 200, game_mode: 'classic' }))
  })

  it('signed out: a negative value is not put in the login return URL', async () => {
    renderHome({ user: null })

    fireEvent.change(await openSettings(), { target: { value: '-5' } })
    fireEvent.click(screen.getByRole('button', { name: /create room/i }))

    expect(fakeBackend.auth.redirectToLogin).toHaveBeenCalledWith(
      `${window.location.origin}/Home?create=1&max_score=200&game_mode=classic`,
    )
  })

  it('clearing the field leaves it empty while typing', async () => {
    renderHome()

    const input = await openSettings()
    fireEvent.change(input, { target: { value: '' } })

    expect(input).toHaveValue(null)
  })

  it('an empty field is sent as 200 on submit', async () => {
    renderHome({ game: { createRoom: createdRoom() } })

    fireEvent.change(await openSettings(), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /create room/i }))

    await waitFor(() => expect(fakeGame.createRoom).toHaveBeenCalledWith({ max_score: 200, game_mode: 'classic' }))
  })
})

describe('Home: settings gear', () => {
  it('says whether the settings are open', async () => {
    renderHome()
    await findCreateButton()
    const gear = screen.getByRole('button', { name: 'Game settings' })
    expect(gear).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(gear)

    expect(gear).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByLabelText(/max score/i)).toBeInTheDocument()
  })

  it('closing the settings removes the field and keeps the chosen score', async () => {
    renderHome({ game: { createRoom: createdRoom() } })
    fireEvent.change(await openSettings(), { target: { value: '150' } })

    fireEvent.click(screen.getByRole('button', { name: 'Game settings' }))

    await waitFor(() => expect(screen.queryByLabelText(/max score/i)).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /create room/i }))
    await waitFor(() => expect(fakeGame.createRoom).toHaveBeenCalledWith({ max_score: 150, game_mode: 'classic' }))
  })

  it('marks the gear only while the max score differs from the default', async () => {
    renderHome()
    const input = await openSettings()
    expect(screen.queryByTestId('custom-settings-dot')).not.toBeInTheDocument()

    fireEvent.change(input, { target: { value: '150' } })
    expect(screen.getByTestId('custom-settings-dot')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: '200' } })
    expect(screen.queryByTestId('custom-settings-dot')).not.toBeInTheDocument()
  })
})

describe('Home: hero cards', () => {
  it('hides the decorative cards from screen readers', async () => {
    renderHome()
    await findCreateButton()

    expect(screen.getByTestId('home-hero-cards')).toHaveAttribute('aria-hidden', 'true')
  })

  it('shows no 7 anywhere in the fan, front or back, and the centre card carries our mark (X73)', async () => {
    renderHome()
    await findCreateButton()

    const fan = screen.getByTestId('home-hero-cards')
    expect(fan).not.toHaveTextContent('7')
    expect(within(fan).getByTestId('home-hero-mark')).toBeInTheDocument()
  })
})

describe('Home: returning from login with create=1', () => {
  it('replaces the URL first, then creates exactly one room, even after a re-render', async () => {
    const view = renderHome({
      url: '/Home?create=1&max_score=150',
      game: { createRoom: createdRoom() },
    })

    await waitFor(() => expect(fakeGame.createRoom).toHaveBeenCalledTimes(1))
    expect(fakeGame.createRoom).toHaveBeenCalledWith({ max_score: 150, game_mode: 'classic' })
    await waitFor(() => expect(currentLocation()).toBe(`/room/${ROOM_CODE}`))

    act(() => view.rerenderHome())
    expect(fakeGame.createRoom).toHaveBeenCalledTimes(1)
  })

  it('removes the create request from the URL while the create is still running', async () => {
    let finishCreate
    renderHome({
      url: '/Home?create=1&max_score=150',
      game: {
        createRoom: () =>
          new Promise((resolve) => {
            finishCreate = resolve
          }),
      },
    })

    await waitFor(() => expect(fakeGame.createRoom).toHaveBeenCalledTimes(1))
    // The router commits the replaced URL in its own render, which can land after the
    // createRoom call; wait for it. createRoom is still pending (finishCreate not yet called).
    await waitFor(() => expect(currentLocation()).toBe('/Home'))

    await act(async () => finishCreate({ room: { code: ROOM_CODE } }))
  })

  it('a failed create shows an error toast and stays on Home with a clean URL', async () => {
    const toastSpy = vi.spyOn(toast, 'error').mockImplementation(() => 'toast-id')
    renderHome({
      url: '/Home?create=1&max_score=150',
      game: { createRoom: () => Promise.reject(new Error('server down')) },
    })

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('Create room failed: server down'))
    // React Router 7 applies a navigation in a transition, so the URL can change after the toast.
    await waitFor(() => expect(currentLocation()).toBe('/Home'))
  })

  it('a negative max_score in the URL creates with 200 (X7)', async () => {
    renderHome({
      url: '/Home?create=1&max_score=-5',
      game: { createRoom: createdRoom() },
    })

    await waitFor(() => expect(fakeGame.createRoom).toHaveBeenCalledWith({ max_score: 200, game_mode: 'classic' }))
  })

  it('without create=1 nothing is created', async () => {
    renderHome({ url: '/Home?max_score=150' })

    await findCreateButton()
    expect(fakeGame.createRoom).not.toHaveBeenCalled()
  })
})

describe('Home: choosing the game mode (X41)', () => {
  const chip = () => screen.findByRole('button', { name: /^Game mode:/ })

  async function chooseMode(label) {
    fireEvent.click(await chip())
    fireEvent.click(await screen.findByRole('radio', { name: label }))
    await waitFor(() => expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument())
  }

  it('shows Classic the first time', async () => {
    renderHome()

    expect(await chip()).toHaveAccessibleName('Game mode: Classic')
  })

  it('selecting a mode closes the dropdown, changes the chip and creates nothing', async () => {
    renderHome()

    await chooseMode('Vengeance')

    expect(await chip()).toHaveAccessibleName('Game mode: Vengeance')
    expect(fakeGame.createRoom).not.toHaveBeenCalled()
  })

  it('creates the room in the chosen mode', async () => {
    renderHome({ game: { createRoom: createdRoom() } })

    await chooseMode('Vengeance')
    fireEvent.click(await findCreateButton())

    await waitFor(() => expect(fakeGame.createRoom).toHaveBeenCalledWith({ max_score: 200, game_mode: 'vengeance' }))
  })

  it('remembers the last mode this device chose', async () => {
    const first = renderHome()
    await chooseMode('Vengeance')
    first.unmount()

    renderHome()

    expect(await chip()).toHaveAccessibleName('Game mode: Vengeance')
  })

  it('reads an unknown remembered mode as Classic', async () => {
    localStorage.setItem('flip7_last_game_mode', JSON.stringify('not-a-mode'))
    renderHome()

    expect(await chip()).toHaveAccessibleName('Game mode: Classic')
  })

  it('signed out: the chosen mode survives login', async () => {
    renderHome({ user: null })

    await chooseMode('Vengeance')
    fireEvent.click(await findCreateButton())

    expect(fakeBackend.auth.redirectToLogin).toHaveBeenCalledWith(
      `${window.location.origin}/Home?create=1&max_score=200&game_mode=vengeance`,
    )
  })

  it('Brutal: the chip, the created room, and surviving login', async () => {
    renderHome({ game: { createRoom: createdRoom() } })

    await chooseMode('Brutal')
    expect(await chip()).toHaveAccessibleName('Game mode: Brutal')
    fireEvent.click(await findCreateButton())

    await waitFor(() => expect(fakeGame.createRoom).toHaveBeenCalledWith({ max_score: 200, game_mode: 'brutal' }))
    expect(document.documentElement.hasAttribute('data-game-mode')).toBe(false)
  })

  it('Brutal: signed out, the chosen mode survives login', async () => {
    renderHome({ user: null })

    await chooseMode('Brutal')
    fireEvent.click(await findCreateButton())

    expect(fakeBackend.auth.redirectToLogin).toHaveBeenCalledWith(
      `${window.location.origin}/Home?create=1&max_score=200&game_mode=brutal`,
    )
  })

  it('returning from login creates in that mode', async () => {
    renderHome({ url: '/Home?create=1&max_score=150&game_mode=vengeance', game: { createRoom: createdRoom() } })

    await waitFor(() => expect(fakeGame.createRoom).toHaveBeenCalledWith({ max_score: 150, game_mode: 'vengeance' }))
  })

  it('Full rules opens the rules sheet on that mode', async () => {
    renderHome()

    fireEvent.click(await chip())
    fireEvent.click(await screen.findByRole('button', { name: 'Full rules for Vengeance' }))

    expect(await screen.findByRole('tab', { name: /Vengeance/ })).toHaveAttribute('aria-selected', 'true')
    // No room yet, so no tab is "This game".
    expect(screen.queryByText('This game')).not.toBeInTheDocument()
  })

  it('closing a sheet opened from Full rules returns to the overlay, on that button', async () => {
    renderHome()
    fireEvent.click(await chip())
    fireEvent.click(await screen.findByRole('button', { name: 'Full rules for Vengeance' }))
    await screen.findByRole('tab', { name: /Vengeance/ })

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    await waitFor(() => expect(screen.queryByRole('tab', { name: /Vengeance/ })).not.toBeInTheDocument())
    expect(await screen.findByRole('radiogroup', { name: 'Game mode' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Full rules for Vengeance' })).toHaveFocus()
  })

  it('the home logo is the app\'s name, whichever mode is chosen', async () => {
    renderHome()

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Showdown')
  })

  it('keeps the classic look with Vengeance selected, because no room exists yet', async () => {
    renderHome()

    await chooseMode('Vengeance')

    expect(document.querySelector('.game-screen-bg[data-game-mode="classic"]')).not.toBeNull()
    expect(document.documentElement.hasAttribute('data-game-mode')).toBe(false)
  })
})

describe('Home: join room', () => {
  it('uppercases the code and opens the room', async () => {
    renderHome()

    fireEvent.change(await screen.findByPlaceholderText(/enter room code/i), {
      target: { value: 'abc234' },
    })
    fireEvent.click(screen.getByRole('button', { name: /join room/i }))

    expect(currentLocation()).toBe('/room/ABC234')
  })

  it('ignores an empty code', async () => {
    renderHome()

    const input = await screen.findByPlaceholderText(/enter room code/i)
    expect(screen.getByRole('button', { name: /join room/i })).toBeDisabled()
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(currentLocation()).toBe('/')
  })

  it('ignores a code that is only spaces', async () => {
    renderHome()

    const input = await screen.findByPlaceholderText(/enter room code/i)
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(currentLocation()).toBe('/')
  })

  it('signed out: redirects to login and returns to the room', async () => {
    renderHome({ user: null })

    fireEvent.change(await screen.findByPlaceholderText(/enter room code/i), {
      target: { value: 'abc234' },
    })
    fireEvent.click(screen.getByRole('button', { name: /join room/i }))

    expect(fakeBackend.auth.redirectToLogin).toHaveBeenCalledWith(
      `${window.location.origin}/room/ABC234`,
    )
  })
})

describe('Home: return to game', () => {
  function rememberRoom() {
    localStorage.setItem(LAST_ROOM_KEY, JSON.stringify({ code: ROOM_CODE }))
  }

  it('shows when the last room still exists and I am in it', async () => {
    rememberRoom()
    renderHome({ game: { lookupRoom: async () => ({ my_player: { id: 'p1' } }) } })

    fireEvent.click(await screen.findByRole('button', { name: `Return to game (${ROOM_CODE})` }))

    expect(currentLocation()).toBe(`/room/${ROOM_CODE}`)
  })

  it('is hidden when I am not a player in the room', async () => {
    rememberRoom()
    renderHome({ game: { lookupRoom: async () => ({ my_player: null }) } })

    await findCreateButton()
    await waitFor(() => expect(fakeGame.lookupRoom).toHaveBeenCalledWith(ROOM_CODE))
    expect(screen.queryByRole('button', { name: /return to game/i })).not.toBeInTheDocument()
  })

  it('is hidden and the memory cleared when the room is gone', async () => {
    rememberRoom()
    const notFound = Object.assign(new Error('not found'), { status: 404 })
    renderHome({ game: { lookupRoom: () => Promise.reject(notFound) } })

    await waitFor(() => expect(localStorage.getItem(LAST_ROOM_KEY)).toBeNull())
    expect(screen.queryByRole('button', { name: /return to game/i })).not.toBeInTheDocument()
  })

  it('is hidden but the memory kept when the lookup fails for another reason', async () => {
    rememberRoom()
    renderHome({ game: { lookupRoom: () => Promise.reject(new Error('offline')) } })

    await findCreateButton()
    await waitFor(() => expect(fakeGame.lookupRoom).toHaveBeenCalled())
    expect(localStorage.getItem(LAST_ROOM_KEY)).not.toBeNull()
    expect(screen.queryByRole('button', { name: /return to game/i })).not.toBeInTheDocument()
  })

  it('is hidden when signed out', async () => {
    rememberRoom()
    renderHome({ user: null })

    await findCreateButton()
    expect(fakeGame.lookupRoom).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /return to game/i })).not.toBeInTheDocument()
  })
})

describe('Home: unofficial disclaimer (X67)', () => {
  it('shows the disclaimer in the page footer', async () => {
    renderHome()
    await findCreateButton()

    expect(screen.getByRole('contentinfo')).toHaveTextContent(UNOFFICIAL_DISCLAIMER)
    expect(UNOFFICIAL_DISCLAIMER).toContain('not affiliated with, endorsed by or sponsored by The Op Games')
  })
})
