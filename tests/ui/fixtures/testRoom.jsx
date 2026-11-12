// testRoom: a room that holds state, for hook and page tests. It plugs a real server room
// (tests/fixtures/serverRoom.js: the server's action code on SQLite) into the fake API modules, so
// `game.*` calls get the server's real replies and conflicts, the entity reads return the room's real
// records, and the realtime events reach whoever subscribed.
//
//   const room = createTestRoom({ players: ['p1', 'p2'], me: 'p1' })
//   afterEach(() => room.close())
//   const view = renderGameHook(() => useGameRoom(), { url: room.url, testRoom: room })
//   await act(async () => room.as('p2', 'submit-score', room.scoreBody(1)))   // another player's move
//
// Calls stay vi.fn()s, so `expect(view.game.submitScore)` still works. Use fakeApi alone for a test
// that only needs a shape.
//
// The order of an action's realtime events and its HTTP reply isn't fixed in real life, and tests of
// that race choose it:
//
//   const held = room.holdReplies()     // my next replies wait until held.release()
//   const held = room.holdEvents()      // events wait until held.release(), for everyone's actions
import { createServerRoom, emailOf } from '../../fixtures/serverRoom.js'
import { fakeBackend, fakeGame } from './fakeApi.jsx'

const ROOM_ENTITIES = ['GameRoom', 'Player', 'RoundScore', 'ChatMessage']

// --- Replies ---------------------------------------------------------------------

/** Rejects like src/api/httpClient.js does for a non-2xx answer. */
function toReply({ status, body }) {
  if (status === 200) {
    return body
  }
  throw Object.assign(new Error(body.message), { status, data: body })
}

/** A gate: `wait()` holds until `release()`. Held calls then go in the order they were made. */
function createGate() {
  let open
  const opened = new Promise((resolve) => {
    open = resolve
  })
  return { wait: () => opened, release: open }
}

// --- Events ----------------------------------------------------------------------

function createEventPipe(serverRoom) {
  const subscribers = new Map()
  for (const entity of ROOM_ENTITIES) {
    subscribers.set(entity, new Set())
  }
  let heldEvents = null

  const deliver = (entity, event, meta) => {
    for (const subscriber of [...subscribers.get(entity)]) {
      subscriber(event, meta)
    }
  }

  serverRoom.listen((entity, event, meta) => {
    if (heldEvents) {
      heldEvents.push([entity, event, meta])
      return
    }
    deliver(entity, event, meta)
  })

  return {
    subscribe(entity, subscriber) {
      subscribers.get(entity).add(subscriber)
      return () => {
        subscribers.get(entity).delete(subscriber)
      }
    },
    hold() {
      heldEvents = []
      return {
        release() {
          const events = heldEvents
          heldEvents = null
          for (const [entity, event, meta] of events) {
            deliver(entity, event, meta)
          }
        },
      }
    },
  }
}

// --- The room --------------------------------------------------------------------

/** game.* name -> how it reaches the server, for every action a room test can run. */
function createGameCalls(room) {
  const action = (actionName, toBody = () => ({})) => (_roomId, ...args) => room.request(actionName, toBody(...args))

  return {
    join: action('join', (body) => body),
    leave: action('leave'),
    kick: action('kick', (playerId) => ({ player_id: playerId })),
    makeHost: action('make-host', (playerId) => ({ player_id: playerId })),
    reorder: action('reorder', (playerIds) => ({ player_ids: playerIds })),
    setGameMode: action('set-game-mode', (gameMode) => ({ game_mode: gameMode })),
    start: action('start'),
    submitScore: action('submit-score', (score) => score),
    retractScore: action('retract-score', (roundNumber) => ({ round_number: roundNumber })),
    forceNextRound: action('force-next-round', (roundNumber) => ({ round_number: roundNumber })),
    setEditMode: action('set-edit-mode', (on) => ({ on })),
    editScore: action('edit-score', (score) => score),
    endGame: action('end-game'),
    reopenGame: action('reopen-game'),
    playAgain: action('play-again'),
    setGamesWon: action('set-games-won', (wins) => ({ wins })),
    closeRoom: action('close'),
    deleteRoom: action('delete'),
  }
}

/**
 * @param {object} [options]
 * @param {string[]} [options.players]  names in turn order; the first is the host
 * @param {string} [options.me]  who this client is signed in as
 * @param {string} [options.gameMode]
 * @param {boolean} [options.start]  false leaves the room in `waiting`
 */
export function createTestRoom({ players = ['p1', 'p2'], me = 'p1', gameMode, start } = {}) {
  const serverRoom = createServerRoom({ players, gameMode, start })
  const events = createEventPipe(serverRoom)
  let replyGate = null

  const room = {
    id: serverRoom.id,
    code: serverRoom.code,
    url: `/room/${serverRoom.code}`,
    user: { id: `user-${me}`, email: emailOf(me), full_name: me },
    me,
    server: serverRoom,
    scoreBody: serverRoom.scoreBody,
    playRound: serverRoom.playRound,
    player: serverRoom.player,

    /** Another player (or my other device) acts. Wrap in act(), as its events reach the hooks. */
    as: serverRoom.act,

    /** My action. Its events go out first, then the reply, like the server's publish-then-respond. */
    async request(actionName, body) {
      const result = serverRoom.act(me, actionName, body)
      if (replyGate) {
        await replyGate.wait()
      }
      return toReply(result)
    },

    holdReplies() {
      const gate = createGate()
      replyGate = gate
      return {
        release() {
          replyGate = null
          gate.release()
        },
      }
    },

    holdEvents: events.hold,

    /** Points the fakes at this room. renderGameHook's `testRoom` option calls it after its reset. */
    install() {
      for (const [name, call] of Object.entries(createGameCalls(room))) {
        fakeGame[name].mockImplementation(call)
      }
      fakeGame.lookupRoom.mockImplementation(async () => toReply(serverRoom.lookup(me)))
      for (const entity of ROOM_ENTITIES) {
        fakeBackend.entities[entity].filter.mockImplementation(async () => serverRoom.records(entity))
        fakeBackend.entities[entity].subscribe.mockImplementation((subscriber) => events.subscribe(entity, subscriber))
      }
    },

    close: serverRoom.close,
  }
  return room
}
