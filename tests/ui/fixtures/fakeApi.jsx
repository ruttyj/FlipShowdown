// Fake versions of the three API modules hook and component tests may mock:
// src/api/game.js, src/api/backend.js and src/api/ai.js.
//
// This file is loaded from inside the vi.mock factories, and importing a module that is itself
// being mocked from there would deadlock. So the only thing it imports from src/ is the real room
// channel, which doesn't reach those modules. Hook tests run through it, over a fake connection.
// renderGameHook.jsx (which does import src/) re-exports what tests need, so tests normally
// only reference this file in their vi.mock lines:
//
//   vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
//   vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
//   vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))
//
// The fakes are module-level singletons, because the hooks capture `game`, `backend`, `realtime`
// and `roomChannel` when they are imported. resetFakeApi() (called by every renderGameHook) puts them
// back to their defaults between tests.
import { vi } from 'vitest'
import { createRoomChannel } from '../../../src/api/roomChannel.js'

// --- game -------------------------------------------------------------------
// One vi.fn() per export of src/api/game.js. renderGameHook.test.jsx checks this list against
// the real module, so a new server action fails that test until it is added here.

export const GAME_ACTION_NAMES = [
  'createRoom',
  'lookupRoom',
  'join',
  'leave',
  'kick',
  'makeHost',
  'reorder',
  'setGameMode',
  'start',
  'submitScore',
  'retractScore',
  'reopenGame',
  'forceNextRound',
  'setEditMode',
  'editScore',
  'endGame',
  'playAgain',
  'setGamesWon',
  'closeRoom',
  'deleteRoom',
]

export const DEFAULT_ACTION_RESPONSE = { ok: true }

function createFakeGame() {
  const fakeGame = {}
  for (const name of GAME_ACTION_NAMES) {
    fakeGame[name] = vi.fn()
  }
  return fakeGame
}

export const fakeGame = createFakeGame()

/**
 * Resets every action to resolve `{ ok: true }`, then applies the overrides.
 *
 * @param {Object<string, Function>} overrides  action name -> implementation, e.g.
 *        `{ kick: () => Promise.reject(error) }`. The vi.fn() itself is kept, so assertions
 *        on `game.kick` still work.
 */
function resetFakeGame(overrides) {
  for (const name of GAME_ACTION_NAMES) {
    fakeGame[name].mockReset()
    fakeGame[name].mockResolvedValue(DEFAULT_ACTION_RESPONSE)
  }

  for (const [name, implementation] of Object.entries(overrides)) {
    if (!fakeGame[name]) {
      throw new Error(`renderGameHook: game has no action called "${name}"`)
    }
    fakeGame[name].mockImplementation(implementation)
  }
}

// --- realtime ---------------------------------------------------------------
// Listener registries like RealtimeConnection's: on*() returns an unsubscribe function, and
// emitRealtime() lets a test deliver a message to the current listeners.

const REALTIME_EVENTS = ['ready', 'resync', 'status', 'presence', 'vote', 'entryStatus']

const realtimeListeners = {}
for (const event of REALTIME_EVENTS) {
  realtimeListeners[event] = new Set()
}

function addRealtimeListener(event, listener) {
  realtimeListeners[event].add(listener)
  return () => {
    realtimeListeners[event].delete(listener)
  }
}

// The real connection is what backend.entities.<Name>.subscribe calls, so tests can deliver and
// inspect subscriptions on either.
function subscribeThroughEntityClient(entity, callback) {
  return fakeBackend.entities[entity].subscribe(callback)
}

export const fakeRealtime = {
  setRooms: vi.fn(),
  signOut: vi.fn(),
  voteHold: vi.fn(),
  voteRelease: vi.fn(),
  entryStatus: vi.fn(),
  subscribe: vi.fn(subscribeThroughEntityClient),
  getStatus: vi.fn(() => 'live'),
  onReady: (listener) => addRealtimeListener('ready', listener),
  onResync: (listener) => addRealtimeListener('resync', listener),
  onStatus: (listener) => addRealtimeListener('status', listener),
  onPresence: (listener) => addRealtimeListener('presence', listener),
  onVote: (listener) => addRealtimeListener('vote', listener),
  onEntryStatus: (listener) => addRealtimeListener('entryStatus', listener),
}

/** Calls every current listener for `event` ('ready', 'resync', 'status', 'presence', 'vote', 'entryStatus'). */
export function emitRealtime(event, message) {
  for (const listener of [...realtimeListeners[event]]) {
    listener(message)
  }
}

// The channel listens to the connection from when it is created, so each reset makes a new one.
// Hooks capture `roomChannel` when they are imported, hence the stable stand-in that forwards.
let currentRoomChannel = createRoomChannel(fakeRealtime)

export const fakeRoomChannel = new Proxy({}, {
  get: (_target, property) => currentRoomChannel[property],
})

function resetFakeRealtime() {
  for (const event of REALTIME_EVENTS) {
    realtimeListeners[event].clear()
  }
  currentRoomChannel = createRoomChannel(fakeRealtime)

  // mockReset drops one-off overrides (mockReturnValue and the like) that a test set, so
  // they can't leak into the next test; the defaults are then put back.
  fakeRealtime.setRooms.mockReset()
  fakeRealtime.signOut.mockReset()
  fakeRealtime.voteHold.mockReset()
  fakeRealtime.voteRelease.mockReset()
  fakeRealtime.entryStatus.mockReset()
  fakeRealtime.subscribe.mockReset()
  fakeRealtime.subscribe.mockImplementation(subscribeThroughEntityClient)
  fakeRealtime.getStatus.mockReset()
  fakeRealtime.getStatus.mockImplementation(() => 'live')
}

// --- backend -----------------------------------------------------------------
// Entities: each has list/filter (resolving []), create (resolving `{ ok: true }`) and
// subscribe (returning an unsubscribe function). Tests override per call with
// `backend.entities.Player.filter.mockResolvedValueOnce([...])`.

export const ENTITY_NAMES = ['GameRoom', 'Player', 'RoundScore', 'ChatMessage']

function createFakeEntity() {
  return {
    list: vi.fn(),
    filter: vi.fn(),
    create: vi.fn(),
    subscribe: vi.fn(),
  }
}

function resetFakeEntity(entity) {
  entity.list.mockReset()
  entity.list.mockResolvedValue([])
  entity.filter.mockReset()
  entity.filter.mockResolvedValue([])
  entity.create.mockReset()
  entity.create.mockResolvedValue(DEFAULT_ACTION_RESPONSE)
  entity.subscribe.mockReset()
  entity.subscribe.mockReturnValue(() => {})
}

function createFakeEntities() {
  const entities = {}
  for (const name of ENTITY_NAMES) {
    entities[name] = createFakeEntity()
  }
  return entities
}

export const fakeBackend = {
  auth: {
    me: vi.fn(),
    isAuthenticated: vi.fn(),
    updateMe: vi.fn(),
    redirectToLogin: vi.fn(),
    logout: vi.fn(),
  },
  entities: createFakeEntities(),
}

function signedOutError() {
  const error = new Error('Not signed in')
  error.status = 401
  return error
}

/** @param {object|null} user  what auth.me() resolves with; null rejects with a 401 */
function resetFakeBackend(user) {
  fakeBackend.auth.redirectToLogin.mockReset()
  fakeBackend.auth.logout.mockReset()
  fakeBackend.auth.updateMe.mockReset()
  fakeBackend.auth.updateMe.mockResolvedValue(user)
  fakeBackend.auth.me.mockReset()
  fakeBackend.auth.isAuthenticated.mockReset()
  fakeBackend.auth.isAuthenticated.mockResolvedValue(user !== null)

  if (user === null) {
    fakeBackend.auth.me.mockRejectedValue(signedOutError())
  } else {
    fakeBackend.auth.me.mockResolvedValue(user)
  }

  for (const name of ENTITY_NAMES) {
    resetFakeEntity(fakeBackend.entities[name])
  }
}

// --- ai ---------------------------------------------------------------------

export const DEFAULT_AI_CONFIG = { enabled: false, default_model: null, models: [] }

export const fakeAi = {
  getAiConfig: vi.fn(),
  scanCards: vi.fn(),
}

function resetFakeAi() {
  fakeAi.getAiConfig.mockReset()
  fakeAi.getAiConfig.mockResolvedValue(DEFAULT_AI_CONFIG)
  fakeAi.scanCards.mockReset()
  fakeAi.scanCards.mockResolvedValue({ cards: [], model: null })
}

// --- Module shapes for vi.mock ----------------------------------------------

export const gameModule = { game: fakeGame }
export const backendModule = { backend: fakeBackend, realtime: fakeRealtime, roomChannel: fakeRoomChannel }
export const aiModule = fakeAi

// --- Reset ------------------------------------------------------------------

/**
 * Puts every fake back to its defaults.
 *
 * @param {{ game?: Object<string, Function>, user?: object|null }} options
 */
export function resetFakeApi({ game = {}, user } = {}) {
  resetFakeGame(game)
  resetFakeRealtime()
  resetFakeBackend(user)
  resetFakeAi()
}
