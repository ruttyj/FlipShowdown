// HoldToVote.
import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import HoldToVote from '@/components/game/HoldToVote'
import { emitRealtime, fakeRealtime, resetFakeApi } from '../fixtures/fakeApi.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

const TOPIC = 'make-host'
const NAMES = { me: 'Me', p2: 'Bo', p3: 'Cy' }

// Every test gets its own room.
let roomCounter = 0
let roomId = ''

beforeEach(() => {
  resetFakeApi({})
  roomCounter += 1
  roomId = `vote-room-${roomCounter}`
})

function renderButton() {
  return render(
    <HoldToVote roomId={roomId} topic={TOPIC} option="p2" label="Bo" myPlayerId="me" holderNames={NAMES} />,
  )
}

function sendVote({ holds = [], pending = null, eligible = ['me', 'p2', 'p3'] } = {}) {
  act(() => {
    emitRealtime('vote', { type: 'vote', room_id: roomId, topic: TOPIC, eligible, holds, pending })
  })
}

function button() {
  return screen.getByRole('button', { name: 'Hold to vote for Bo' })
}

function pressPointer(init = {}) {
  button().setPointerCapture = vi.fn()
  fireEvent.pointerDown(button(), { isPrimary: true, button: 0, pointerId: 1, ...init })
}

describe('holding and releasing', () => {
  it('pointer down holds and pointer up releases', () => {
    renderButton()

    pressPointer()
    expect(fakeRealtime.voteHold).toHaveBeenCalledWith(roomId, TOPIC, 'p2')

    fireEvent.pointerUp(button())
    expect(fakeRealtime.voteRelease).toHaveBeenCalledWith(roomId, TOPIC)
  })

  it('a right click does not hold', () => {
    renderButton()

    pressPointer({ button: 2 })

    expect(fakeRealtime.voteHold).not.toHaveBeenCalled()
  })

  it('cancelling the pointer releases', () => {
    renderButton()

    pressPointer()
    fireEvent.pointerCancel(button())

    expect(fakeRealtime.voteRelease).toHaveBeenCalledTimes(1)
  })

  it('losing pointer capture releases', () => {
    renderButton()

    pressPointer()
    fireEvent.lostPointerCapture(button())

    expect(fakeRealtime.voteRelease).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['Enter', 'Enter'],
    ['Space', ' '],
  ])('%s holds on key down and releases on key up', (_name, key) => {
    renderButton()

    fireEvent.keyDown(button(), { key })
    expect(fakeRealtime.voteHold).toHaveBeenCalledWith(roomId, TOPIC, 'p2')

    fireEvent.keyUp(button(), { key })
    expect(fakeRealtime.voteRelease).toHaveBeenCalledWith(roomId, TOPIC)
  })

  it('key repeat does not send the hold again', () => {
    renderButton()

    fireEvent.keyDown(button(), { key: 'Enter' })
    fireEvent.keyDown(button(), { key: 'Enter', repeat: true })

    expect(fakeRealtime.voteHold).toHaveBeenCalledTimes(1)
  })

  it('other keys do nothing', () => {
    renderButton()

    fireEvent.keyDown(button(), { key: 'a' })

    expect(fakeRealtime.voteHold).not.toHaveBeenCalled()
  })

  it('window blur releases a hold', () => {
    renderButton()
    fireEvent.keyDown(button(), { key: 'Enter' })

    fireEvent.blur(window)

    expect(fakeRealtime.voteRelease).toHaveBeenCalledTimes(1)
  })
})

describe('states', () => {
  it('is idle with nobody holding', () => {
    renderButton()
    sendVote()

    expect(button()).toHaveAttribute('data-status', 'idle')
    expect(screen.getByText('Press and hold')).toBeInTheDocument()
  })

  it('is green when only I hold it', () => {
    renderButton()
    sendVote({ holds: [{ player_id: 'me', option: 'p2' }] })

    expect(button()).toHaveAttribute('data-status', 'mine')
    expect(button().className).toContain('bg-emerald-100')
  })

  it('is green when another player and I both hold it', () => {
    renderButton()
    sendVote({
      holds: [
        { player_id: 'me', option: 'p2' },
        { player_id: 'p3', option: 'p2' },
      ],
    })

    expect(button()).toHaveAttribute('data-status', 'mine')
    expect(button().className).toContain('bg-emerald-100')
  })

  it('is blue when another player holds it and I do not', () => {
    renderButton()
    sendVote({ holds: [{ player_id: 'p3', option: 'p2' }] })

    expect(button()).toHaveAttribute('data-status', 'others')
    expect(button().className).toContain('bg-blue-100')
    expect(button().className).not.toContain('emerald')
  })

  it('stays blue through a countdown I am not part of', () => {
    const { container } = renderButton()
    sendVote({
      holds: [{ player_id: 'p3', option: 'p2' }],
      pending: { option: 'p2', remaining_ms: 1500 },
    })

    expect(button()).toHaveAttribute('data-status', 'pending')
    expect(button().className).toContain('bg-blue-200')
    expect(container.querySelector('[aria-hidden="true"]').className).toContain('bg-blue-500/40')
  })

  it('is green through a countdown I am part of', () => {
    const { container } = renderButton()
    sendVote({
      holds: [{ player_id: 'me', option: 'p2' }],
      pending: { option: 'p2', remaining_ms: 1500 },
    })

    expect(button().className).toContain('bg-emerald-200')
    expect(container.querySelector('[aria-hidden="true"]').className).toContain('bg-emerald-500/40')
  })

  it('is pending with a progress bar when the countdown runs', () => {
    const { container } = renderButton()
    sendVote({
      holds: [
        { player_id: 'me', option: 'p2' },
        { player_id: 'p3', option: 'p2' },
      ],
      pending: { option: 'p2', remaining_ms: 1500 },
    })

    expect(button()).toHaveAttribute('data-status', 'pending')
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull()
  })

  it('shows no progress bar unless pending', () => {
    const { container } = renderButton()
    sendVote({ holds: [{ player_id: 'me', option: 'p2' }] })

    expect(container.querySelector('[aria-hidden="true"]')).toBeNull()
  })

  it('lists the holder names', () => {
    renderButton()
    sendVote({
      holds: [
        { player_id: 'me', option: 'p2' },
        { player_id: 'p3', option: 'p2' },
      ],
    })

    expect(screen.getByText('Holding: Me, Cy')).toBeInTheDocument()
  })

  it('ignores holds on another option', () => {
    renderButton()
    sendVote({ holds: [{ player_id: 'p3', option: 'me' }] })

    expect(screen.getByText('Press and hold')).toBeInTheDocument()
  })
})
