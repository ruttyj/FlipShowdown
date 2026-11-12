// useGameRoom: leaving and being kicked, sign-in, AI config, chat, chimes and cues
// (X3 and X3b). Joining is in
// useGameRoom.join.test.jsx. The room lives in a small fake server the tests change
// between refetches.
import { act, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useChatMute } from '@/hooks/useRoomChat'
import { useGameRoom } from '@/pages/gameRoom/useGameRoom'
import { DEFAULT_USER, makePlayer, makeRoom, renderGameHook, ROOM_CODE, ROOM_ID } from '../fixtures/renderGameHook.jsx'
import { fakeAi } from '../fixtures/fakeApi.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

const MODEL_KEY = 'flip7_current_model'
const OTHER_CODE = 'XYZ789'

// --- Fake audio ------------------------------------------------------------------
// The chimes are Web Audio tones; each chime is its own run of pitches. The app caches
// one AudioContext after first use, so its methods write to the module-level `played`.

const played = { frequencies: [], types: [] }
const CHIME_TONES = {
  waiting: [523.25, 659.25, 783.99],
  playing: [659.25, 783.99, 1046.5],
  finished: [1046.5, 783.99, 659.25, 783.99],
  nextRound: [1318.51, 987.77, 1318.51],
}

class FakeAudioContext {
  constructor() {
    this.state = 'running'
    this.currentTime = 0
    this.destination = {}
  }

  createOscillator() {
    const oscillator = {
      frequency: { value: 0 },
      connect() {},
      stop() {},
    }
    oscillator.start = () => {
      played.frequencies.push(oscillator.frequency.value)
      played.types.push(oscillator.type)
    }
    return oscillator
  }

  createGain() {
    return {
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {},
    }
  }
}


// Chimes are muted (setup.js clears localStorage after each test) so their timers can't leak
// into the next test; the chime tests switch sound on.
beforeEach(() => {
  localStorage.setItem('flip7_sound_muted', 'true')
  played.frequencies = []
  played.types = []
  vi.stubGlobal('AudioContext', FakeAudioContext)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// --- Fake server -----------------------------------------------------------------

const MY_PLAYER_ID = 'p1'

function createServer({ isMember = true, status = 'waiting', code = ROOM_CODE, id = ROOM_ID, messages = [] } = {}) {
  const room = makeRoom({
    id,
    code,
    status,
    host_player_id: 'p2',
    host_email: 'p2@example.com',
    current_turn_player_id: null,
  })
  const players = [makePlayer('p2', { room_id: id, is_host: true })]
  if (isMember) {
    players.push(makePlayer(MY_PLAYER_ID, { room_id: id, turn_order: 1 }))
  }
  return { room, players, messages }
}

function findMe(server) {
  return server.players.find((player) => player.id === MY_PLAYER_ID) ?? null
}

function removeMe(server) {
  server.players = server.players.filter((player) => player.id !== MY_PLAYER_ID)
}

/** Changes the room the way the server does: every change bumps the version. */
function changeRoom(server, changes) {
  server.room = { ...server.room, ...changes, version: server.room.version + 1 }
}

function installMemberReads(entities, servers) {
  const readMine = (roomId) => {
    const server = servers.find((candidate) => candidate.room.id === roomId)
    if (!server || !findMe(server)) {
      return null
    }
    return server
  }

  entities.GameRoom.filter.mockImplementation(async ({ id }) => {
    const server = readMine(id)
    return server ? [server.room] : []
  })
  entities.Player.filter.mockImplementation(async ({ room_id: roomId }) => {
    const server = readMine(roomId)
    return server ? server.players : []
  })
  entities.ChatMessage.filter.mockImplementation(async ({ room_id: roomId }) => {
    const server = readMine(roomId)
    return server ? server.messages : []
  })
}

/**
 * Renders useGameRoom at /room/<code> against the fake servers. `aiConfig` is what
 * the AI config request answers (set during the first render, before the request is made).
 */
function renderRoom(servers, { code = ROOM_CODE, game = {}, answers, user, aiConfig } = {}) {
  const serverList = Array.isArray(servers) ? servers : [servers]
  const serverGame = {
    lookupRoom: async (lookupCode) => {
      const server = serverList.find((candidate) => candidate.room.code === lookupCode)
      return { room: server.room, players: server.players, my_player: findMe(server) }
    },
    leave: async (roomId) => {
      removeMe(serverList.find((candidate) => candidate.room.id === roomId))
      return { ok: true }
    },
    ...game,
  }

  const options = { url: `/room/${code}`, game: serverGame, answers }
  if (user !== undefined) {
    options.user = user
  }
  let isConfigured = false
  const view = renderGameHook(() => {
    if (aiConfig && !isConfigured) {
      isConfigured = true
      fakeAi.getAiConfig.mockImplementation(async () => {
        if (aiConfig instanceof Error) {
          throw aiConfig
        }
        return aiConfig
      })
    }
    return { ...useGameRoom(), chatMute: useChatMute() }
  }, options)
  installMemberReads(view.backend.entities, serverList)
  return view
}

async function waitForSettled(view) {
  await waitFor(() => {
    const current = view.result.current
    expect(current.load.status).toBe('ready')
    expect(current.load.isSigningIn).toBe(false)
    expect(current.joining.isAutoJoining).toBe(false)
  })
  await act(async () => {})
}

async function refetchRoom(view) {
  await act(() => view.result.current.load.retry())
}

function spyOnErrorToast() {
  return vi.spyOn(toast, 'error').mockImplementation(() => {})
}

// --- The interface ---------------------------------------------------------------

test('the result is grouped by room concept and leaks no raw setter', async () => {
  const view = renderRoom(createServer())
  await waitForSettled(view)
  const { chatMute: _chatMute, ...game } = view.result.current

  expect(Object.keys(game).sort()).toEqual([
    'chat', 'dialogs', 'goHome', 'host', 'joining', 'leave', 'load', 'scanModels', 'scoreEntry', 'table', 'theme',
  ])
  const leaked = []
  for (const group of Object.values(game)) {
    for (const name of Object.keys(group)) {
      if (['setAnimatingEmoji', 'setChatOpen', 'setConfirmDialog', 'setCurrentModel', 'setPlayerName', 'setShowGamesWonEditor'].includes(name)) {
        leaked.push(name)
      }
    }
  }
  expect(leaked).toEqual([])
})

// --- Leave and kick -------------------------------------------------------------

/**
 * Calls leave() and answers the hook's own confirm dialog (the screen would show it).
 * Returns the dialog as it was asked, so a test can read its text.
 */
async function leaveAnswering(view, confirmed) {
  let leaving
  act(() => {
    leaving = view.result.current.leave()
  })
  await waitFor(() => {
    expect(view.result.current.dialogs.confirmation.open).toBe(true)
  })
  const dialog = view.result.current.dialogs.confirmation
  await act(async () => {
    if (confirmed) {
      dialog.onConfirm()
    } else {
      dialog.onCancel()
    }
    await leaving
  })
  return dialog
}

test('leave asks first and does nothing when declined', async () => {
  const view = renderRoom(createServer())
  await waitForSettled(view)

  const dialog = await leaveAnswering(view, false)

  expect(dialog.title).toBe('Leave Game?')
  expect(view.game.leave).not.toHaveBeenCalled()
  expect(view.location().pathname).toBe(`/room/${ROOM_CODE}`)
})

test('leave says that hosting passes on when I am the host', async () => {
  const server = createServer()
  server.room = { ...server.room, host_player_id: MY_PLAYER_ID, host_email: DEFAULT_USER.email }
  server.players = server.players.map((player) => ({ ...player, is_host: player.id === MY_PLAYER_ID }))
  const view = renderRoom(server)
  await waitForSettled(view)

  const dialog = await leaveAnswering(view, false)

  expect(dialog.description).toContain('Hosting passes')
})

test('leave goes ahead when confirmed', async () => {
  const view = renderRoom(createServer())
  await waitForSettled(view)

  await leaveAnswering(view, true)

  expect(view.game.leave).toHaveBeenCalledWith(ROOM_ID)
  expect(view.location().pathname).toBe('/Home')
})

test('leaving on purpose is not reported as being kicked', async () => {
  const errorToast = spyOnErrorToast()
  const view = renderRoom(createServer())
  await waitForSettled(view)

  await leaveAnswering(view, true)
  await refetchRoom(view)
  await waitFor(() => {
    expect(view.result.current.table.hasJoined).toBe(false)
  })

  expect(errorToast).not.toHaveBeenCalled()
})

test('a failed leave still reports a later removal as a kick', async () => {
  const errorToast = spyOnErrorToast()
  const server = createServer()
  const failure = Object.assign(new Error('Server busy'), { status: 500 })
  const view = renderRoom(server, { game: { leave: () => Promise.reject(failure) } })
  await waitForSettled(view)

  await leaveAnswering(view, true)
  expect(view.location().pathname).toBe(`/room/${ROOM_CODE}`)
  errorToast.mockClear()

  removeMe(server)
  await refetchRoom(view)

  await waitFor(() => {
    expect(errorToast).toHaveBeenCalledWith('You were removed from the game')
  })
})

test('my Player deleted while the room is open: a kicked notice and the score entry closes', async () => {
  const errorToast = spyOnErrorToast()
  const server = createServer({ status: 'playing' })
  const view = renderRoom(server)
  await waitForSettled(view)
  act(() => {
    view.result.current.scoreEntry.openScoreEntry('manual')
  })
  expect(view.result.current.scoreEntry.showManualEntry).toBe(true)

  removeMe(server)
  await refetchRoom(view)

  await waitFor(() => {
    expect(errorToast).toHaveBeenCalledTimes(1)
  })
  expect(errorToast).toHaveBeenCalledWith('You were removed from the game')
  expect(view.result.current.table.hasJoined).toBe(false)
  expect(view.result.current.scoreEntry.showManualEntry).toBe(false)
})

test('a leave answering player_not_found counts as done', async () => {
  const errorToast = spyOnErrorToast()
  const gone = Object.assign(new Error('Player not found'), { status: 404, data: { code: 'player_not_found' } })
  const view = renderRoom(createServer(), { game: { leave: () => Promise.reject(gone) } })
  await waitForSettled(view)

  await leaveAnswering(view, true)

  expect(view.location().pathname).toBe('/Home')
  expect(errorToast).not.toHaveBeenCalled()
})

// --- Sign-in ---------------------------------------------------------------------

test('signed out: redirects to login with the current URL', async () => {
  const view = renderRoom(createServer({ isMember: false }), { user: null })

  await waitFor(() => {
    expect(view.backend.auth.redirectToLogin).toHaveBeenCalledWith(window.location.href)
  })
  expect(window.location.pathname).toBe(`/room/${ROOM_CODE}`)
})

// --- AI config -------------------------------------------------------------------

const MODELS = [{ id: 'm-a', label: 'A' }, { id: 'm-b', label: 'B' }]

test('AI config: not known until loaded, then enabled with its models', async () => {
  const view = renderRoom(createServer(), { aiConfig: { enabled: true, default_model: 'm-a', models: MODELS } })

  expect(view.result.current.scanModels).toMatchObject({ enabled: null, models: [] })
  await waitFor(() => {
    expect(view.result.current.scanModels.enabled).toBe(true)
  })
  expect(view.result.current.scanModels.models).toEqual(MODELS)
})

test('AI config: disabled', async () => {
  const view = renderRoom(createServer(), { aiConfig: { enabled: false, default_model: null, models: [] } })

  await waitFor(() => {
    expect(view.result.current.scanModels.enabled).toBe(false)
  })
  expect(view.result.current.scanModels.models).toEqual([])
})

test('AI config: an unreachable config is treated as disabled', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const view = renderRoom(createServer(), { aiConfig: new Error('offline') })

  await waitFor(() => {
    expect(view.result.current.scanModels).toMatchObject({ enabled: false, models: [] })
  })
})

// --- AI model storage ------------------------------------------------------------

test('the chosen AI model is read from storage and written back when changed', async () => {
  localStorage.setItem(MODEL_KEY, 'm-b')
  const view = renderRoom(createServer(), { aiConfig: { enabled: true, default_model: 'm-a', models: MODELS } })

  await waitFor(() => {
    expect(view.result.current.scanModels.models[0].id).toBe('m-b')
  })
  act(() => {
    view.result.current.scanModels.rememberModel('m-a')
  })

  expect(localStorage.getItem(MODEL_KEY)).toBe('m-a')
  expect(view.result.current.scanModels.models[0].id).toBe('m-a')
})

test('blocked storage does not throw when reading or writing the model', async () => {
  const view = renderRoom(createServer())
  await waitForSettled(view)
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked')
  })

  expect(() => {
    act(() => {
      view.result.current.scanModels.rememberModel('m-a')
    })
  }).not.toThrow()

  // A fresh mount reads blocked storage too.
  view.unmount()
  expect(() => renderRoom(createServer())).not.toThrow()
})

// --- Incoming chat ---------------------------------------------------------------

function chatMessage(id, overrides = {}) {
  return { id, room_id: ROOM_ID, sender_id: 'p2', recipient_id: MY_PLAYER_ID, emoji: 'X', message: 'hi', ...overrides }
}

test('messages loaded with the room do not animate; a new one for me animates once', async () => {
  const server = createServer({ messages: [chatMessage('old')] })
  const view = renderRoom(server)
  await waitForSettled(view)
  expect(view.result.current.chat.playing).toBeNull()

  server.messages = [...server.messages, chatMessage('new', { message: 'look' })]
  await refetchRoom(view)

  await waitFor(() => {
    expect(view.result.current.chat.playing?.id).toBe('new')
  })
  expect(view.result.current.chat.playing).toMatchObject({
    emoji: 'X',
    sender: 'p2',
    message: 'look',
    recipients: [{ id: MY_PLAYER_ID, name: 'You' }],
    isForMe: true,
  })

  act(() => {
    view.result.current.chat.dismissPlaying()
  })
  await refetchRoom(view)
  await act(async () => {})
  expect(view.result.current.chat.playing).toBeNull()
})

test('a message between others animates for me too, labelled, without the cue', async () => {
  const server = createServer()
  const view = renderRoom(server)
  await waitForSettled(view)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')

  server.messages = [chatMessage('mine', { sender_id: MY_PLAYER_ID, recipient_id: 'p2' })]
  await refetchRoom(view)

  await waitFor(() => {
    expect(view.result.current.chat.playing?.id).toBe('mine')
  })
  expect(view.result.current.chat.playing).toMatchObject({
    sender: 'You',
    recipients: [{ id: 'p2', name: 'p2' }],
    isForMe: false,
  })
  expect(document.title).not.toContain('New message')
})

test('the per-recipient parts of one send arriving together play as one item', async () => {
  const server = createServer()
  const view = renderRoom(server)
  await waitForSettled(view)

  server.messages = [
    chatMessage('to-p2', { sender_id: 'p9', recipient_id: 'p2' }),
    chatMessage('to-me', { sender_id: 'p9' }),
  ]
  await refetchRoom(view)

  await waitFor(() => {
    expect(view.result.current.chat.playing?.isForMe).toBe(true)
  })
  expect(view.result.current.chat.playing.recipients).toEqual([
    { id: 'p2', name: 'p2' },
    { id: MY_PLAYER_ID, name: 'You' },
  ])
})

test('a message from an unknown sender is shown as Someone', async () => {
  const server = createServer()
  const view = renderRoom(server)
  await waitForSettled(view)

  server.messages = [chatMessage('ghost', { sender_id: 'p9', message: undefined })]
  await refetchRoom(view)

  await waitFor(() => {
    expect(view.result.current.chat.playing?.sender).toBe('Someone')
  })
  expect(view.result.current.chat.playing.message).toBe('')
})

test('seen ids reset on a room change: the new room history does not animate', async () => {
  const first = createServer({ messages: [chatMessage('a')] })
  const second = createServer({
    id: 'room-2',
    code: OTHER_CODE,
    messages: [chatMessage('b', { room_id: 'room-2' })],
  })
  const view = renderRoom([first, second])
  await waitForSettled(view)

  window.history.replaceState(null, '', `/room/${OTHER_CODE}`)
  view.rerender()
  await waitFor(() => {
    expect(view.result.current.table.room?.id).toBe('room-2')
    expect(view.result.current.table.hasJoined).toBe(true)
  })
  await act(async () => {})

  expect(view.result.current.chat.playing).toBeNull()
})

// --- Chat mute (X44) -------------------------------------------------------------

async function renderMutedRoom(server) {
  localStorage.setItem('flip7_chat_muted', 'true')
  const view = renderRoom(server)
  await waitForSettled(view)
  return view
}

async function deliver(view, server, ...messages) {
  server.messages = [...server.messages, ...messages]
  await refetchRoom(view)
}

/** My own send always plays, so seeing it proves everything before it has been processed. */
async function deliverMyOwnSendAndWaitForIt(view, server, id) {
  await deliver(view, server, chatMessage(id, { sender_id: MY_PLAYER_ID, recipient_id: 'p2' }))
  await waitFor(() => {
    expect(view.result.current.chat.playing?.id).toBe(id)
  })
}

test('muting closes the open chat dialog, as its button is hidden too', async () => {
  const view = renderRoom(createServer())
  await waitForSettled(view)

  act(() => {
    view.result.current.chat.toggleOpen()
  })
  expect(view.result.current.chat.isOpen).toBe(true)
  expect(view.result.current.chat.isMuted).toBe(false)

  act(() => {
    view.result.current.chatMute.toggleChatMute()
  })

  expect(view.result.current.chat.isMuted).toBe(true)
  expect(view.result.current.chat.isOpen).toBe(false)
})

test('a double tap opens the chat dialog, and another closes it (X79)', async () => {
  const view = renderRoom(createServer())
  await waitForSettled(view)

  act(() => {
    view.result.current.chat.doubleTapChatButton()
  })
  expect(view.result.current.chat.isOpen).toBe(true)

  act(() => {
    view.result.current.chat.doubleTapChatButton()
  })
  expect(view.result.current.chat.isOpen).toBe(false)
  expect(view.result.current.chat.quickSendsOpen).toBe(false)
})

test('muting folds open quick sends, so unmuting brings the button back folded (X79)', async () => {
  const view = renderRoom(createServer())
  await waitForSettled(view)

  act(() => {
    view.result.current.chat.tapChatButton()
  })
  expect(view.result.current.chat.quickSendsOpen).toBe(true)

  act(() => {
    view.result.current.chatMute.toggleChatMute()
  })

  expect(view.result.current.chat.quickSendsOpen).toBe(false)
})

test('muted: a message to me shows nothing, cues nothing and pulses the button once', async () => {
  const server = createServer()
  const view = await renderMutedRoom(server)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')

  await deliver(view, server, chatMessage('to-me'))

  await waitFor(() => {
    expect(view.result.current.chatMute.pulseKey).toBe(1)
  })
  expect(view.result.current.chat.playing).toBeNull()
  expect(document.title).not.toContain('New message')
})

test('muted: the parts of one send to several players pulse once', async () => {
  const server = createServer()
  const view = await renderMutedRoom(server)

  await deliver(view, server, chatMessage('to-p3', { recipient_id: 'p3' }), chatMessage('to-me'))

  await waitFor(() => {
    expect(view.result.current.chatMute.pulseKey).toBe(1)
  })
  await act(async () => {})
  expect(view.result.current.chatMute.pulseKey).toBe(1)
})

test('muted: a message between other players does nothing at all', async () => {
  const server = createServer()
  const view = await renderMutedRoom(server)

  await deliver(view, server, chatMessage('between-others', { sender_id: 'p2', recipient_id: 'p3' }))
  await deliverMyOwnSendAndWaitForIt(view, server, 'mine')

  expect(view.result.current.chatMute.pulseKey).toBe(0)
})

test('muted: my own send plays as normal, as my confirmation', async () => {
  const server = createServer()
  const view = await renderMutedRoom(server)

  await deliverMyOwnSendAndWaitForIt(view, server, 'mine')

  expect(view.result.current.chat.playing).toMatchObject({ sender: 'You', isForMe: false })
  expect(view.result.current.chatMute.pulseKey).toBe(0)
})

test('tapping mute while an item plays closes it', async () => {
  const server = createServer()
  const view = renderRoom(server)
  await waitForSettled(view)
  await deliver(view, server, chatMessage('playing'))
  await waitFor(() => {
    expect(view.result.current.chat.playing?.id).toBe('playing')
  })

  act(() => view.result.current.chatMute.toggleChatMute())

  expect(view.result.current.chat.playing).toBeNull()
})

test('unmuting replays nothing; only messages arriving from then on show', async () => {
  const server = createServer()
  const view = await renderMutedRoom(server)
  await deliver(view, server, chatMessage('missed'))
  await waitFor(() => {
    expect(view.result.current.chatMute.pulseKey).toBe(1)
  })

  act(() => view.result.current.chatMute.toggleChatMute())
  await refetchRoom(view)
  await act(async () => {})
  expect(view.result.current.chat.playing).toBeNull()

  await deliver(view, server, chatMessage('after-unmute'))
  await waitFor(() => {
    expect(view.result.current.chat.playing?.id).toBe('after-unmute')
  })
  expect(view.result.current.chatMute.pulseKey).toBe(1)
})

test('muted: messages already in the room when it loads do not pulse', async () => {
  const server = createServer({ messages: [chatMessage('old')] })
  const view = await renderMutedRoom(server)

  await deliverMyOwnSendAndWaitForIt(view, server, 'mine')

  expect(view.result.current.chatMute.pulseKey).toBe(0)
})

// --- Chimes ----------------------------------------------------------------------

test('chimes play on waiting, waiting -> playing and playing -> finished', async () => {
  localStorage.setItem('flip7_sound_muted', 'false')
  const server = createServer({ status: 'waiting' })
  const view = renderRoom(server)
  await waitForSettled(view)
  await waitFor(() => {
    expect(played.frequencies).toEqual(CHIME_TONES.waiting)
  })

  changeRoom(server, { status: 'playing' })
  await refetchRoom(view)
  await waitFor(() => {
    expect(played.frequencies).toEqual([...CHIME_TONES.waiting, ...CHIME_TONES.playing])
  })

  changeRoom(server, { status: 'finished' })
  await refetchRoom(view)
  await waitFor(() => {
    expect(played.frequencies).toEqual([
      ...CHIME_TONES.waiting,
      ...CHIME_TONES.playing,
      ...CHIME_TONES.finished,
    ])
  })
})

// X64: a soft bell when the last score of a round moves the game to the next one.
test('a soft bell plays when the round goes up during a game, not on opening one mid-game', async () => {
  localStorage.setItem('flip7_sound_muted', 'false')
  const server = createServer({ status: 'playing' })
  server.room = { ...server.room, current_round: 3 }
  const view = renderRoom(server)
  await waitForSettled(view)
  await waitFor(() => {
    expect(played.frequencies).toEqual(CHIME_TONES.playing)
  })

  changeRoom(server, { current_round: 4 })
  await refetchRoom(view)
  await waitFor(() => {
    expect(played.frequencies).toEqual([...CHIME_TONES.playing, ...CHIME_TONES.nextRound])
  })
  expect(played.types.slice(-3)).toEqual(['triangle', 'triangle', 'triangle'])
})

test('the round going back to 1 (a rematch) plays no bell', async () => {
  localStorage.setItem('flip7_sound_muted', 'false')
  const server = createServer({ status: 'playing' })
  server.room = { ...server.room, current_round: 5 }
  const view = renderRoom(server)
  await waitForSettled(view)
  await waitFor(() => {
    expect(played.frequencies).toEqual(CHIME_TONES.playing)
  })

  changeRoom(server, { current_round: 1 })
  await refetchRoom(view)
  changeRoom(server, { status: 'finished' })
  await refetchRoom(view)
  await waitFor(() => {
    expect(played.frequencies).toEqual([...CHIME_TONES.playing, ...CHIME_TONES.finished])
  })
})

test('the waiting chime is for joined players only', async () => {
  localStorage.setItem('flip7_sound_muted', 'false')
  const view = renderRoom(createServer({ status: 'waiting', isMember: false }), {
    game: { join: async () => ({ ok: true }) },
  })
  await waitForSettled(view)
  await new Promise((resolve) => setTimeout(resolve, 300))

  expect(view.result.current.table.hasJoined).toBe(false)
  expect(played.frequencies).toEqual([])
})

// --- Attention cues --------------------------------------------------------------

test('cues fire on game start and on my turn', async () => {
  const server = createServer({ status: 'waiting' })
  const view = renderRoom(server)
  await waitForSettled(view)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  expect(document.title).not.toContain('Game started')

  changeRoom(server, { status: 'playing', current_turn_player_id: 'p2' })
  await refetchRoom(view)
  await waitFor(() => {
    expect(document.title).toContain('Game started')
  })

  changeRoom(server, { current_turn_player_id: MY_PLAYER_ID })
  await refetchRoom(view)
  await waitFor(() => {
    expect(document.title).toContain('Your turn')
  })
})

test('opening a room already on my turn does not cue', async () => {
  const server = createServer({ status: 'playing' })
  server.room = { ...server.room, current_turn_player_id: MY_PLAYER_ID }
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  const view = renderRoom(server)
  await waitForSettled(view)

  expect(document.title).not.toContain('Your turn')
  expect(document.title).not.toContain('Game started')
})

