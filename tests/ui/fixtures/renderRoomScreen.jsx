// renderRoomScreen: renders a room screen with the real useGameRoom result, against a fake room.
//
//   const screenView = await renderRoomScreen(ActiveGameScreen, {
//     me: makePlayer('p1'), others: [makePlayer('p2', { turn_order: 1 })], isHost: false,
//     room: { game_mode: 'brutal' },                     // goes through the real room reads
//     roundScores: [...],
//     busy: { retractScore: true },                      // table.busy
//     scoreEntry: { showManualEntry: true },             // any other group of the interface
//   })
//   expect(screenView.game.scoreEntry.bust).toHaveBeenCalled()
//   screenView.update({ room: { current_round: 2 } })    // the room changed; synchronous
//
// The room, players and scores go through the real hook. An override replaces one value of the
// real interface, and naming a value the interface doesn't have throws, so a test can't pass with a
// shape production never produces. What a tap on a screen runs is a spy by default (actionSpies);
// a test of what an action really does belongs against the hook or a test room.
//
// Needs the three vi.mock lines from renderGameHook.jsx.
import { render, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import { useGameRoom } from '@/pages/gameRoom/useGameRoom'
import { createQueryClient, createWrapper, makeRoom, ROOM_CODE } from './renderGameHook.jsx'
import { fakeBackend, fakeGame, resetFakeApi } from './fakeApi.jsx'

// --- Overrides -------------------------------------------------------------------

function actionSpies() {
  return {
    leave: vi.fn(),
    goHome: vi.fn(),
    dialogs: { openGamesWon: vi.fn() },
    scoreEntry: {
      bust: vi.fn(async () => ({ kind: 'saved' })),
      openScoreEntry: vi.fn(),
      takeBackScore: vi.fn(),
      addMinusCard: vi.fn(),
      startScanning: vi.fn(),
      clearEnteredScoreRound: vi.fn(),
    },
    host: {
      kick: vi.fn(),
      makeHost: vi.fn(),
      reorder: vi.fn(),
      setFirstPlayer: vi.fn(),
      start: vi.fn(),
      forceNextRound: vi.fn(),
      setEditMode: vi.fn(),
      endGame: vi.fn(),
      reopenGame: vi.fn(),
      playAgain: vi.fn(),
      closeRoom: vi.fn(),
      deleteRoom: vi.fn(),
    },
  }
}

function isGroup(value) {
  return value !== null && typeof value === 'object'
}

function overlayGroup(groupName, group, values) {
  for (const name of Object.keys(values)) {
    if (!(name in group)) {
      throw new Error(`renderRoomScreen: useGameRoom's ${groupName} has no "${name}"`)
    }
  }
  return { ...group, ...values }
}

/** The real interface with `overrides` laid over it; an unknown name throws. */
function overlay(real, overrides) {
  const merged = { ...real }
  for (const [name, value] of Object.entries(overrides)) {
    if (!(name in real)) {
      throw new Error(`renderRoomScreen: useGameRoom has no "${name}"`)
    }
    merged[name] = isGroup(real[name]) ? overlayGroup(name, real[name], value) : value
  }
  return merged
}

function mergeGroups(base, extra) {
  const merged = { ...base }
  for (const [name, value] of Object.entries(extra)) {
    merged[name] = isGroup(value) && isGroup(base[name]) ? { ...base[name], ...value } : value
  }
  return merged
}

// --- Rendering -------------------------------------------------------------------

function RoomScreenHarness({ Screen, overrides, latest }) {
  const real = useGameRoom()
  latest.real = real
  if (!real.table.hasJoined) {
    return null
  }

  const game = overlay(real, overrides)
  latest.game = game
  return <Screen game={game} />
}

function installRoom({ room, players, me, roundScores }) {
  fakeGame.lookupRoom.mockImplementation(async () => ({ room, players, my_player: me }))
  fakeBackend.entities.GameRoom.filter.mockImplementation(async () => [room])
  fakeBackend.entities.Player.filter.mockImplementation(async () => players)
  fakeBackend.entities.RoundScore.filter.mockImplementation(async () => roundScores)
}

/**
 * @param {Function} Screen  takes { game }
 * @param {object} options
 * @param {object} options.me
 * @param {object[]} [options.others]
 * @param {boolean} [options.isHost]
 * @param {object} [options.room]  fields over makeRoom()
 * @param {object[]} [options.roundScores]
 * @param {object} [options.busy]  table.busy
 * Anything else is a group of the interface, e.g. `scoreEntry: { showScanner: true }`.
 */
export async function renderRoomScreen(Screen, { me, others = [], isHost = false, room, roundScores = [], busy, ...groups }) {
  const myPlayer = { ...me, is_host: isHost }
  const players = [myPlayer, ...others]
  const roomRecord = makeRoom({ ...room, host_player_id: isHost ? me.id : others[0]?.id ?? null })
  const user = { id: `user-${me.id}`, email: me.email, full_name: me.name }

  // Chimes run on timers that would outlive the test.
  localStorage.setItem('flip7_sound_muted', 'true')
  resetFakeApi({ game: {}, user })
  installRoom({ room: roomRecord, players, me: myPlayer, roundScores })
  const url = `/room/${ROOM_CODE}`
  window.history.replaceState(null, '', url)

  const Wrapper = createWrapper({ queryClient: createQueryClient(), url })
  const latest = { real: null, game: null }
  const spies = actionSpies()

  const build = (changes) => {
    const { room: roomChanges, roundScores: newScores, busy: newBusy, ...groupChanges } = changes
    const table = {}
    if (roomChanges) {
      table.room = { ...roomRecord, ...roomChanges }
    }
    if (newScores) {
      table.roundScores = newScores
    }
    if (newBusy) {
      table.busy = newBusy
    }
    return mergeGroups({ table }, groupChanges)
  }

  let current = mergeGroups(mergeGroups(spies, build({ busy })), groups)
  const tree = () => (
    <Wrapper>
      <RoomScreenHarness Screen={Screen} overrides={current} latest={latest} />
    </Wrapper>
  )

  const view = render(tree())
  await waitFor(() => {
    if (!latest.game) {
      throw new Error('renderRoomScreen: the room has not loaded')
    }
  })

  return {
    get game() {
      return latest.game
    },
    update(changes) {
      current = mergeGroups(current, build(changes))
      view.rerender(tree())
    },
  }
}
