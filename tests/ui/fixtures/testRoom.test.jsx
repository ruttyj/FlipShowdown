// The room fixture itself: every game call reaches a real server action, replies are the server's own,
// and the two holds decide what arrives first.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeBackend, fakeGame, resetFakeApi } from './fakeApi.jsx'
import { createTestRoom } from './testRoom.jsx'

let room

function install(options) {
  room = createTestRoom(options)
  resetFakeApi({ user: room.user })
  room.install()
}

afterEach(() => {
  room.close()
})

describe('the room behind the fakes', () => {
  it('answers a submit with the server\'s real reply', async () => {
    install()

    const reply = await fakeGame.submitScore(room.id, room.scoreBody(1))

    expect(reply.already_applied).toBe(false)
    expect(reply.round_score.final_score).toBe(5)
    expect(reply.players).toHaveLength(2)
  })

  it('rejects a conflict the way the HTTP client does', async () => {
    install()
    room.as('p1', 'force-next-round', { round_number: 1 })

    await expect(fakeGame.submitScore(room.id, room.scoreBody(1))).rejects.toMatchObject({
      status: 409,
      data: { code: 'round_mismatch', current_round: 2 },
    })
  })

  it('reads and looks up the room as the signed-in player', async () => {
    install({ me: 'p2' })

    const lookup = await fakeGame.lookupRoom(room.code)
    const scores = await fakeBackend.entities.RoundScore.filter({ room_id: room.id })

    expect(lookup.my_player.id).toBe(room.player('p2').id)
    expect(scores).toEqual([])
  })

  it.each([
    ['setEditMode', () => [true]],
    ['forceNextRound', () => [1]],
    ['retractScore', () => [1]],
    ['setGamesWon', () => [{}]],
    ['endGame', () => []],
    ['closeRoom', () => []],
  ])('%s reaches a real action', async (name, args) => {
    install()

    await expect(fakeGame[name](room.id, ...args())).resolves.toHaveProperty('room.id', room.id)
  })
})

describe('what arrives first', () => {
  it('events go out before a held reply', async () => {
    install()
    const heard = vi.fn()
    fakeBackend.entities.GameRoom.subscribe(heard)
    const replies = room.holdReplies()

    const reply = fakeGame.setEditMode(room.id, true)
    expect(heard).toHaveBeenCalled()

    const settled = vi.fn()
    reply.then(settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    replies.release()
    await reply
    expect(settled).toHaveBeenCalled()
  })

  it('held events wait for the release, with the real event shape', async () => {
    install()
    const heard = vi.fn()
    fakeBackend.entities.GameRoom.subscribe(heard)
    const events = room.holdEvents()

    await fakeGame.setEditMode(room.id, true)
    expect(heard).not.toHaveBeenCalled()

    events.release()
    const [event, meta] = heard.mock.calls[0]
    expect(event).toMatchObject({ type: 'update', id: room.id, data: { is_edit_mode: true } })
    expect(meta.room_version).toBe(event.data.version)
  })

  it('stops telling a subscriber who left', async () => {
    install()
    const heard = vi.fn()
    const off = fakeBackend.entities.GameRoom.subscribe(heard)
    off()

    await fakeGame.setEditMode(room.id, true)

    expect(heard).not.toHaveBeenCalled()
  })
})
