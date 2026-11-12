// renderGameHook: renders a room hook (src/pages/gameRoom/, src/hooks/) with Testing Library's
// renderHook, inside the providers the app gives it and against fake API modules.
//
// --- 1. Mock the API modules (copy these three lines into the test file) -------
// vi.mock is hoisted to the top of each test file, so it can't be called from here. Every
// hook test copies these lines verbatim (paths are relative to tests/ui/hooks/):
//
//   vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
//   vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
//   vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))
//
// These are the only module mocks allowed. Never mock the hook under test.
//
// --- 2. Render -------------------------------------------------------------------
//   const view = renderGameHook((fixture, props) => useHostActions({ room, players, isHost: true, ...fixture }), options)
//
// The callback runs inside the providers on every render. `fixture` holds exactly the
// arguments the room hooks take by these names, so it can be spread into them:
//   perform   the real useActionRunner's perform (its refetch is `view.refetch`)
//   confirm   resolves from the answer queue: true for `true`/'confirm', false otherwise
//   ask       resolves from the answer queue: 'confirm' | 'cancel' | 'dismiss' (true -> 'confirm', false -> 'cancel')
//   navigate  react-router's navigate, wrapped in a vi.fn()
// `props` is renderHook's props (`initialProps`, then whatever `view.rerender(props)` passes).
//
// Options (all optional):
//   url           initial URL, e.g. '/room/ABC234' (default '/'). Also written to
//                 window.location, because useGameRoom reads the code from there.
//   route         a route path such as '/room/:code'; the hook then renders inside
//                 <Routes><Route path={route}>, so useParams works. A URL that doesn't
//                 match renders nothing (view.result.current stays null).
//   game          { actionName: implementation } overrides, e.g. { kick: () => Promise.reject(error) }.
//                 Every other action resolves { ok: true }.
//   answers       the confirm/ask answer queue, e.g. [true, 'cancel']. Answering with an
//                 empty queue throws, so an unexpected prompt fails the test.
//   user          what backend.auth.me() resolves with (default DEFAULT_USER); null = signed out (401).
//   initialProps  passed to renderHook.
//   testRoom      a room from createTestRoom (testRoom.jsx): real replies and a real room behind the fakes.
//
// Returns renderHook's { result, rerender, unmount } plus:
//   game, backend, realtime, ai   the fakes (vi.fn()s), for assertions and per-call overrides
//   emitRealtime(event, msg)     delivers a realtime message ('ready', 'resync', 'status', 'presence', 'vote', 'entryStatus')
//   confirm, ask, navigate       the same vi.fn()s the hook received
//   refetch                      vi.fn() given to useActionRunner
//   queueAnswers(...answers)     appends to the answer queue mid-test
//   busy()                       useActionRunner's current busy flags, e.g. { kick: false }
//   location()                   the router's current location ({ pathname, search, ... })
//   queryClient                  the fresh QueryClient (retries off)
//
// --- 3. Example --------------------------------------------------------------------
//   const room = makeRoom()
//   const players = [makePlayer('p1', { is_host: true }), makePlayer('p2', { turn_order: 1 })]
//   const view = renderGameHook((fixture) => useHostActions({ room, players, isHost: true, ...fixture }), {
//     answers: [true],
//   })
//   await act(() => view.result.current.kick('p2'))
//   expect(view.game.kick).toHaveBeenCalledWith(room.id, 'p2')
//   expect(view.refetch).toHaveBeenCalled()
//
// The fakes are shared singletons reset by each renderGameHook call, so configure them
// through the options (or after rendering), not before it.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { vi } from 'vitest'
import { ChatMuteProvider } from '@/hooks/useRoomChat'
import { SoundProvider } from '@/components/useSound'
import { AuthProvider } from '@/lib/AuthContext'
import { useActionRunner } from '@/pages/gameRoom/useActionRunner'
import {
  emitRealtime,
  fakeAi,
  fakeBackend,
  fakeGame,
  fakeRealtime,
  resetFakeApi,
} from './fakeApi.jsx'

// --- Room and player builders --------------------------------------------------
// Shapes follow the server's records (server/src/gameActions/rooms.js and players.js).

export const ROOM_ID = 'room-1'
export const ROOM_CODE = 'ABC234'

export const DEFAULT_USER = { id: 'user-p1', email: 'p1@example.com', full_name: 'Player One' }

/** A room in play, round 1, with p1 as host. */
export function makeRoom(overrides = {}) {
  return {
    id: ROOM_ID,
    code: ROOM_CODE,
    status: 'playing',
    host_email: DEFAULT_USER.email,
    host_player_id: 'p1',
    max_score: 200,
    current_round: 1,
    current_turn_player_id: 'p1',
    is_edit_mode: false,
    edit_mode_by: null,
    winner_player_id: null,
    finish_reason: null,
    game_number: 1,
    version: 1,
    ...overrides,
  }
}

/** A player in ROOM_ID whose name and email derive from `id` (e.g. 'p2' -> p2@example.com). */
export function makePlayer(id, overrides = {}) {
  return {
    id,
    room_id: ROOM_ID,
    email: `${id}@example.com`,
    name: id,
    is_host: false,
    turn_order: 0,
    total_score: 0,
    current_round_score: 0,
    has_submitted_round: false,
    games_won: 0,
    last_seen: null,
    ...overrides,
  }
}

// --- Answer queue ----------------------------------------------------------------

function takeAnswer(queue, kind, options) {
  if (queue.length === 0) {
    const title = options?.title ?? '(no title)'
    throw new Error(`renderGameHook: ${kind}("${title}") was called but the answer queue is empty`)
  }
  return queue.shift()
}

function toConfirmAnswer(answer) {
  return answer === true || answer === 'confirm'
}

function toAskAnswer(answer) {
  if (answer === true) {
    return 'confirm'
  }
  if (answer === false) {
    return 'cancel'
  }
  return answer
}

function createPrompts(queue) {
  return {
    confirm: vi.fn(async (options) => toConfirmAnswer(takeAnswer(queue, 'confirm', options))),
    ask: vi.fn(async (options) => toAskAnswer(takeAnswer(queue, 'ask', options))),
  }
}

// --- Providers -------------------------------------------------------------------

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
}

function RoutedChildren({ route, children }) {
  if (!route) {
    return children
  }

  return (
    <Routes>
      <Route path={route} element={children} />
    </Routes>
  )
}

export function createWrapper({ queryClient, url, route }) {
  return function GameHookProviders({ children }) {
    return (
      <AuthProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[url]}>
            <SoundProvider>
              <ChatMuteProvider>
                <RoutedChildren route={route}>{children}</RoutedChildren>
              </ChatMuteProvider>
            </SoundProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </AuthProvider>
    )
  }
}

// --- Hook harness ----------------------------------------------------------------

/**
 * Runs inside the providers: builds the fixture from the real router and useActionRunner,
 * records what the test reads back through `latest`, then calls the test's hook.
 */
function useFixture({ useHook, props, refetch, prompts, navigateSpy, latest }) {
  const routerNavigate = useNavigate()
  const location = useLocation()
  const { busy, perform } = useActionRunner({ refetch })

  latest.navigate = routerNavigate
  latest.location = location
  latest.busy = busy

  const fixture = {
    perform,
    confirm: prompts.confirm,
    ask: prompts.ask,
    navigate: navigateSpy,
  }
  return useHook(fixture, props)
}

/**
 * @param {(fixture: {perform: Function, confirm: Function, ask: Function, navigate: Function}, props: any) => any} useHook
 * @param {object} [options]  see the header comment
 */
export function renderGameHook(useHook, options = {}) {
  const {
    url = '/',
    route,
    game = {},
    answers = [],
    user = DEFAULT_USER,
    initialProps,
    testRoom,
  } = options

  resetFakeApi({ game, user: testRoom?.user ?? user })
  testRoom?.install()
  window.history.replaceState(null, '', url)

  const queue = [...answers]
  const prompts = createPrompts(queue)
  const refetch = vi.fn()
  const latest = { navigate: null, location: null, busy: {} }
  // Stable across renders, so tests can assert on it; forwards to the live router navigate.
  const navigateSpy = vi.fn((...args) => latest.navigate(...args))
  const queryClient = createQueryClient()

  const harness = { useHook, refetch, prompts, navigateSpy, latest }
  const view = renderHook((props) => useFixture({ ...harness, props }), {
    wrapper: createWrapper({ queryClient, url, route }),
    initialProps,
  })

  return {
    result: view.result,
    rerender: view.rerender,
    unmount: view.unmount,
    game: fakeGame,
    backend: fakeBackend,
    realtime: fakeRealtime,
    ai: fakeAi,
    emitRealtime,
    confirm: prompts.confirm,
    ask: prompts.ask,
    navigate: navigateSpy,
    refetch,
    queueAnswers: (...more) => {
      queue.push(...more)
    },
    busy: () => latest.busy,
    location: () => latest.location,
    queryClient,
  }
}
