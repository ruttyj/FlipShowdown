// Brutal on screen (X43): the Flip 7 chooser on all three entry screens, the score table's marks, the
// bust panel's minus cards, and what the mode brings to the logo, picker and rules.
import React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { RulesButton } from '@/components/game/RulesSheet'
import CardScanner from '@/components/game/CardScanner'
import ManualScoreEntry from '@/components/game/ManualScoreEntry'
import ModeShift from '@/components/game/ModeShift'
import ScoreEditor from '@/components/game/ScoreEditor'
import Scoreboard from '@/components/game/Scoreboard'
import { SoundProvider } from '@/components/useSound'
import { getRules } from '@/lib/gameRules'
import GameLogo from '@/pages/gameRoom/GameLogo'
import ActiveGameScreen from '@/pages/gameRoom/ActiveGameScreen'
import RoomHeader from '@/pages/gameRoom/RoomHeader'
import { makePlayer, makeRoom } from '../fixtures/renderGameHook.jsx'
import { renderRoomScreen } from '../fixtures/renderRoomScreen.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

beforeAll(() => {
  Element.prototype.scrollTo = vi.fn()
})

const SAM = { id: 'sam', name: 'Sam' }
const JO = { id: 'jo', name: 'Jo' }
const TARGETS = [SAM, JO]
const KEEP_BONUS = 'Keep the +15'
const FROM_SAM = '−15 from Sam'

function number(value) {
  return { type: 'number', value: String(value) }
}

function minus(value) {
  return { type: 'subtractor', value: String(value) }
}

const FLIP_SEVEN = [1, 2, 3, 4, 5, 6, 7].map(number)

const finalScoreShown = (value) => screen.getByText(String(value), { selector: 'p' })
const chooser = () => screen.queryByRole('radiogroup', { name: /Flip 7/ })

function renderManual(props = {}) {
  const onScoreConfirmed = vi.fn()
  const view = render(
    <ManualScoreEntry
      gameMode="brutal"
      attackTargets={TARGETS}
      onScoreConfirmed={onScoreConfirmed}
      onCancel={vi.fn()}
      {...props}
    />,
  )
  return { onScoreConfirmed, user: userEvent.setup(), ...view }
}

function renderScanner(props = {}) {
  const onCardsConfirmed = vi.fn()
  render(
    <SoundProvider>
      <CardScanner
        gameMode="brutal"
        attackTargets={TARGETS}
        onCardsConfirmed={onCardsConfirmed}
        onCancel={vi.fn()}
        onManualEntry={vi.fn()}
        aiEnabled={true}
        modelList={[]}
        setCurrentModel={vi.fn()}
        {...props}
      />
    </SoundProvider>,
  )
  return { onCardsConfirmed, user: userEvent.setup() }
}

const EDITOR_PLAYERS = [
  { id: 'ann', name: 'Ann', total_score: 0 },
  { id: 'sam', name: 'Sam', total_score: 0 },
]

function renderEditor({ initialEdit = {}, roundScores = [], players = EDITOR_PLAYERS, gameMode = 'brutal' } = {}) {
  const onSaveScore = vi.fn().mockResolvedValue({ ok: true })
  render(
    <ScoreEditor
      players={players}
      roundScores={roundScores}
      room={{ current_round: 1, game_mode: gameMode }}
      initialEdit={{ player_id: 'ann', round_number: 1, cards: FLIP_SEVEN, ...initialEdit }}
      onSaveScore={onSaveScore}
      onClose={vi.fn()}
      isSaving={false}
      isClosing={false}
    />,
  )
  return { onSaveScore, user: userEvent.setup() }
}

// --- The chooser ----------------------------------------------------------------

describe('Flip 7 chooser on manual entry', () => {
  it('shows only on a seven-card hand', () => {
    renderManual({ initialCards: [1, 2, 3].map(number) })

    expect(chooser()).not.toBeInTheDocument()
  })

  it('defaults to +15 and needs a deliberate choice', async () => {
    const { onScoreConfirmed, user } = renderManual({ initialCards: FLIP_SEVEN })

    expect(screen.getByRole('radio', { name: KEEP_BONUS })).toBeChecked()
    expect(screen.getByRole('radio', { name: FROM_SAM })).not.toBeChecked()
    expect(finalScoreShown(43)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /confirm score/i }))

    expect(onScoreConfirmed.mock.calls[0][0]).toMatchObject({ finalScore: 43, bonus: 15, flip7AttackPlayerId: null })
  })

  it('choosing a rival makes the bonus 0 and sends who', async () => {
    const onAttackChange = vi.fn()
    const { onScoreConfirmed, user } = renderManual({ initialCards: FLIP_SEVEN, onAttackChange })

    await user.click(screen.getByRole('radio', { name: FROM_SAM }))

    expect(finalScoreShown(28)).toBeInTheDocument()
    expect(onAttackChange).toHaveBeenLastCalledWith('sam')
    await user.click(screen.getByRole('button', { name: /confirm score/i }))
    expect(onScoreConfirmed.mock.calls[0][0]).toMatchObject({ finalScore: 28, bonus: 0, flip7AttackPlayerId: 'sam' })
  })

  it('choosing +15 again gives it back', async () => {
    const onAttackChange = vi.fn()
    const { user } = renderManual({ initialCards: FLIP_SEVEN, onAttackChange })
    await user.click(screen.getByRole('radio', { name: FROM_SAM }))

    await user.click(screen.getByRole('radio', { name: KEEP_BONUS }))

    expect(finalScoreShown(43)).toBeInTheDocument()
    expect(onAttackChange).toHaveBeenLastCalledWith(null)
  })

  it('comes back from a restored draft', () => {
    renderManual({ initialCards: FLIP_SEVEN, initialAttackPlayerId: 'sam' })

    expect(screen.getByRole('radio', { name: FROM_SAM })).toBeChecked()
    expect(finalScoreShown(28)).toBeInTheDocument()
  })

  it('a target who has left falls back to +15', () => {
    renderManual({ initialCards: FLIP_SEVEN, initialAttackPlayerId: 'gone' })

    expect(screen.getByRole('radio', { name: KEEP_BONUS })).toBeChecked()
    expect(finalScoreShown(43)).toBeInTheDocument()
  })

  it('a choice left over from a hand that stopped being a Flip 7 does nothing and is not sent', async () => {
    const { onScoreConfirmed, user } = renderManual({
      initialCards: [1, 2, 3, 4, 5, 6].map(number),
      initialAttackPlayerId: 'sam',
    })

    await user.click(screen.getByRole('button', { name: /confirm score/i }))

    expect(onScoreConfirmed.mock.calls[0][0]).toMatchObject({ finalScore: 21, flip7AttackPlayerId: null })
  })

  it('is not offered with nobody to attack', () => {
    renderManual({ initialCards: FLIP_SEVEN, attackTargets: [] })

    expect(chooser()).not.toBeInTheDocument()
    expect(finalScoreShown(43)).toBeInTheDocument()
  })

  it('moves no focus, so no keyboard opens when the hand reaches seven', () => {
    renderManual({ initialCards: FLIP_SEVEN })

    expect(document.activeElement.getAttribute('role')).not.toBe('radio')
    expect(document.activeElement.type).not.toBe('radio')
  })

  it.each(['classic', 'vengeance'])('is not offered in %s', (gameMode) => {
    renderManual({ gameMode, initialCards: FLIP_SEVEN })

    expect(chooser()).not.toBeInTheDocument()
    expect(finalScoreShown(43)).toBeInTheDocument()
  })

  it('the host switching away from Brutal takes the attack with it, keeping the cards', () => {
    const common = { initialCards: FLIP_SEVEN, attackTargets: TARGETS, initialAttackPlayerId: 'sam', onScoreConfirmed: vi.fn(), onCancel: vi.fn() }
    const { rerender } = render(<ManualScoreEntry gameMode="brutal" {...common} />)
    expect(finalScoreShown(28)).toBeInTheDocument()

    rerender(<ManualScoreEntry gameMode="vengeance" {...common} />)

    expect(chooser()).not.toBeInTheDocument()
    expect(finalScoreShown(43)).toBeInTheDocument()
  })
})

describe('Flip 7 chooser on the scanner', () => {
  it('shows on a seven-card hand and sends the choice', async () => {
    const { onCardsConfirmed, user } = renderScanner({ initialCards: FLIP_SEVEN })

    expect(screen.getByRole('radio', { name: KEEP_BONUS })).toBeChecked()
    await user.click(screen.getByRole('radio', { name: FROM_SAM }))
    await user.click(screen.getByRole('button', { name: /confirm score/i }))

    expect(onCardsConfirmed.mock.calls[0][0]).toMatchObject({ finalScore: 28, flip7AttackPlayerId: 'sam' })
  })

  it('does not show on a shorter hand', () => {
    renderScanner({ initialCards: [1, 2].map(number) })

    expect(chooser()).not.toBeInTheDocument()
  })

  it('comes back from a restored draft, and retaking the photo forgets it', async () => {
    const onAttackChange = vi.fn()
    const { user } = renderScanner({ initialCards: FLIP_SEVEN, initialAttackPlayerId: 'sam', onAttackChange })
    expect(screen.getByRole('radio', { name: FROM_SAM })).toBeChecked()

    await user.click(screen.getByRole('button', { name: /retake photo/i }))

    expect(onAttackChange).toHaveBeenLastCalledWith(null)
  })
})

describe('Flip 7 chooser in the score editor', () => {
  it('offers everyone but the score\'s owner, including the host', () => {
    renderEditor({ players: [...EDITOR_PLAYERS, { id: 'host', name: 'Host', total_score: 0 }] })

    expect(screen.getByRole('radio', { name: FROM_SAM })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '−15 from Host' })).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: '−15 from Ann' })).not.toBeInTheDocument()
  })

  it('saves the choice', async () => {
    const { onSaveScore, user } = renderEditor()

    await user.click(screen.getByRole('radio', { name: FROM_SAM }))
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    expect(onSaveScore).toHaveBeenCalledWith(expect.objectContaining({
      player_id: 'ann',
      final_score: 28,
      flip7_attack_player_id: 'sam',
    }))
  })

  it('opens on the attack a stored score has, from a late score', () => {
    renderEditor({ initialEdit: { flip7_attack_player_id: 'sam' } })

    expect(screen.getByRole('radio', { name: FROM_SAM })).toBeChecked()
    expect(finalScoreShown(28)).toBeInTheDocument()
  })

  it('opens on the attack a stored score has, from the grid, and Cancel forgets it', async () => {
    const stored = { id: 's1', player_id: 'ann', round_number: 1, cards: FLIP_SEVEN, final_score: 28, flip7_attack_player_id: 'sam' }
    const onSaveScore = vi.fn().mockResolvedValue({ ok: true })
    const user = userEvent.setup()
    render(
      <ScoreEditor
        players={EDITOR_PLAYERS}
        roundScores={[stored]}
        room={{ current_round: 1, game_mode: 'brutal' }}
        initialEdit={null}
        onSaveScore={onSaveScore}
        onClose={vi.fn()}
        isSaving={false}
        isClosing={false}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Edit round 1 score for Ann' }))
    expect(await screen.findByRole('radio', { name: FROM_SAM })).toBeChecked()

    await user.click(screen.getByRole('button', { name: /cancel/i }))
    await user.click(await screen.findByRole('button', { name: 'Edit round 1 score for Sam' }))
    expect(chooser()).not.toBeInTheDocument()
  })

  it('a stored attack on someone who has left opens on +15', () => {
    renderEditor({ initialEdit: { flip7_attack_player_id: 'gone' } })

    expect(screen.getByRole('radio', { name: KEEP_BONUS })).toBeChecked()
  })

  it('turning Bust on takes the chooser away, and the attack with it', async () => {
    const { onSaveScore, user } = renderEditor({ initialEdit: { flip7_attack_player_id: 'sam' } })

    await user.click(screen.getByRole('switch', { name: 'Bust' }))

    expect(chooser()).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^save$/i }))
    const saved = onSaveScore.mock.calls[0][0]
    expect(saved.busted).toBe(true)
    expect(saved.flip7_attack_player_id).toBeUndefined()
  })

  it('shows the −15 in the grid too, as the total wouldn\'t add up without it', () => {
    const stored = { id: 's1', player_id: 'ann', round_number: 1, cards: FLIP_SEVEN, final_score: 28, flip7_attack_player_id: 'sam' }
    render(
      <ScoreEditor
        players={EDITOR_PLAYERS}
        roundScores={[stored]}
        room={{ current_round: 1, game_mode: 'brutal' }}
        initialEdit={null}
        onSaveScore={vi.fn()}
        onClose={vi.fn()}
        isSaving={false}
        isClosing={false}
      />,
    )

    expect(screen.getByText('−15 from Ann')).toBeInTheDocument()
  })
})

// --- The score table ------------------------------------------------------------

describe('Scoreboard marks', () => {
  const players = [
    makePlayer('ann', { name: 'Ann', total_score: 28 }),
    makePlayer('sam', { name: 'Sam', total_score: -15, turn_order: 1 }),
  ]
  const attack = { id: 's1', player_id: 'ann', round_number: 1, final_score: 28, flip7_attack_player_id: 'sam' }

  function rowFor(name) {
    return screen.getByText(name).closest('tr')
  }

  it('marks the target\'s round cell with who took the 15', () => {
    render(<Scoreboard players={players} currentRound={1} roundScores={[attack]} />)

    expect(within(rowFor('Sam')).getByText('−15 from Ann')).toBeInTheDocument()
    expect(within(rowFor('Ann')).queryByText(/−15 from/)).not.toBeInTheDocument()
  })

  it('marks the cell next to the target\'s own score', () => {
    const own = { id: 's2', player_id: 'sam', round_number: 1, final_score: 9 }
    render(<Scoreboard players={players} currentRound={1} roundScores={[attack, own]} />)

    const row = within(rowFor('Sam'))
    expect(row.getByText('9')).toBeInTheDocument()
    expect(row.getByText('−15 from Ann')).toBeInTheDocument()
  })

  it('marks a BUST cell, with its negative score', () => {
    const bust = { id: 's2', player_id: 'sam', round_number: 1, final_score: -6, busted: true }
    render(<Scoreboard players={players} currentRound={1} roundScores={[attack, bust]} />)

    const row = within(rowFor('Sam'))
    expect(row.getByText('BUST')).toBeInTheDocument()
    expect(row.getByText('−15 from Ann')).toBeInTheDocument()
  })

  // Names aren't unique, and a player who has left is "Someone" however many there are.
  it('two attackers with the same name each get a mark', () => {
    const consoleError = vi.spyOn(console, 'error')
    const twin = { id: 's2', player_id: 'ann2', round_number: 1, final_score: 28, flip7_attack_player_id: 'sam' }
    const twins = [...players, makePlayer('ann2', { name: 'Ann', total_score: 28, turn_order: 2 })]
    render(<Scoreboard players={twins} currentRound={1} roundScores={[attack, twin]} />)

    expect(within(screen.getByText('Sam').closest('tr')).getAllByText('−15 from Ann')).toHaveLength(2)
    const keyWarnings = consoleError.mock.calls.filter(([message]) => String(message).includes('same key'))
    expect(keyWarnings).toEqual([])
    consoleError.mockRestore()
  })

  it('a mark breaks after the −15, as "from Sam" fits a phone\'s narrow column on one line', () => {
    render(<Scoreboard players={players} currentRound={1} roundScores={[attack]} />)

    expect(within(rowFor('Sam')).getByText('−15 from Ann').textContent).toBe('−15 from\u00a0Ann')
  })

  it('a target with a mark and no score still has the dash', () => {
    render(<Scoreboard players={players} currentRound={1} roundScores={[attack]} />)

    expect(within(rowFor('Sam')).getByText('-')).toBeInTheDocument()
  })

  it('marks the round it happened in, not every round', () => {
    const later = { id: 's3', player_id: 'sam', round_number: 2, final_score: 3 }
    render(<Scoreboard players={players} currentRound={2} roundScores={[attack, later]} />)

    expect(within(rowFor('Sam')).getAllByText('−15 from Ann')).toHaveLength(1)
  })

  // BUST -10 is wider than BUST, and would end up under the sticky Total column.
  it('scrolls again when a score\'s value changes, as its cell may have grown', () => {
    const scrollTo = vi.spyOn(Element.prototype, 'scrollTo')
    const bust = { id: 's2', player_id: 'sam', round_number: 1, final_score: 0, busted: true }
    const { rerender } = render(<Scoreboard players={players} currentRound={1} roundScores={[bust]} />)
    scrollTo.mockClear()

    rerender(<Scoreboard players={players} currentRound={1} roundScores={[{ ...bust, final_score: -10 }]} />)

    expect(scrollTo).toHaveBeenCalledTimes(1)
  })

  it('an attack on someone who has left marks nobody', () => {
    const onGone = { ...attack, flip7_attack_player_id: 'gone' }
    render(<Scoreboard players={players} currentRound={1} roundScores={[onGone]} />)

    expect(screen.queryByText(/−15 from/)).not.toBeInTheDocument()
  })
})

// --- The bust panel -------------------------------------------------------------

function renderActive({ me = makePlayer('p1', { has_submitted_round: true }), room, ...options } = {}) {
  return renderRoomScreen(ActiveGameScreen, {
    me,
    others: [makePlayer('p2', { name: 'Sam', turn_order: 1 })],
    room: { game_mode: 'brutal', ...room },
    theme: { mode: 'brutal' },
    ...options,
  })
}

function myBust(fields = {}) {
  return { id: 's1', player_id: 'p1', round_number: 1, final_score: 0, cards: [], busted: true, ...fields }
}

describe('the Bust tile in Brutal', () => {
  const me = makePlayer('p1')
  const openStep = async () => {
    const props = await renderActive({ me })
    fireEvent.click(screen.getByRole('button', { name: 'Bust' }))
    return props
  }
  const tapMinus = (value) => fireEvent.click(screen.getByRole('button', { name: `Add −${value}` }))

  it('asks for minus cards before anything is sent', async () => {
    const props = await openStep()

    expect(screen.getByRole('heading', { name: 'Mark as bust' })).toBeInTheDocument()
    expect(screen.getByText('Score so far: 0')).toBeInTheDocument()
    expect(props.game.scoreEntry.bust).not.toHaveBeenCalled()
  })

  it('sends the chosen cards with the bust', async () => {
    const props = await openStep()

    tapMinus(6)
    tapMinus(2)
    expect(screen.getByText('Score so far: −8')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Bust' }))

    expect(props.game.scoreEntry.bust).toHaveBeenCalledWith(['6', '2'])
  })

  it('a mistaken tap can be removed', async () => {
    const props = await openStep()
    tapMinus(6)
    tapMinus(2)

    const applied = within(screen.getByRole('region', { name: 'Applied to you' }))
    fireEvent.click(applied.getByRole('button', { name: 'Remove −6' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Bust' }))

    expect(props.game.scoreEntry.bust).toHaveBeenCalledWith(['2'])
  })

  it('Cancel goes back to the tiles and forgets the cards', async () => {
    const props = await openStep()
    tapMinus(6)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.game.scoreEntry.bust).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Bust' }))

    expect(screen.getByText('Score so far: 0')).toBeInTheDocument()
  })

  it('goes back to the tiles if the host switches to a mode without late modifiers', async () => {
    const props = await openStep()

    props.update({ room: { game_mode: 'vengeance' } })

    expect(screen.queryByRole('heading', { name: 'Mark as bust' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Bust' })).toBeInTheDocument()
  })

  it('doesn\'t carry over into the next round', async () => {
    const props = await openStep()

    props.update({ room: { game_mode: 'brutal', current_round: 2 } })

    expect(screen.queryByRole('heading', { name: 'Mark as bust' })).not.toBeInTheDocument()
  })

  it('stays open with its cards when the bust failed, so it can be sent again', async () => {
    const props = await openStep()
    props.game.scoreEntry.bust.mockResolvedValueOnce({ kind: 'failed' })
    tapMinus(6)

    fireEvent.click(screen.getByRole('button', { name: 'Confirm Bust' }))
    await waitFor(() => expect(props.game.scoreEntry.bust).toHaveBeenCalled())
    await act(async () => {})

    expect(screen.getByRole('heading', { name: 'Mark as bust' })).toBeInTheDocument()
    expect(screen.getByText('Score so far: −6')).toBeInTheDocument()
  })

  it('closes once the server has answered, whatever it said', async () => {
    const props = await openStep()
    props.game.scoreEntry.bust.mockResolvedValueOnce({ kind: 'round_moved', currentRound: 2, storedScore: null })

    fireEvent.click(screen.getByRole('button', { name: 'Confirm Bust' }))

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Mark as bust' })).not.toBeInTheDocument())
  })

  it('Confirm waits while the bust is on its way', async () => {
    const props = await openStep()

    props.update({ busy: { submitScore: true } })

    expect(screen.getByRole('button', { name: 'Submitting…' })).toBeDisabled()
  })

  it('other modes keep the plain tile', async () => {
    const props = await renderActive({ me, room: { game_mode: 'vengeance' } })

    fireEvent.click(screen.getByRole('button', { name: 'Bust' }))

    expect(props.game.scoreEntry.bust).toHaveBeenCalledWith()
  })
})

describe('the bust panel in Brutal (§3.14)', () => {
  const minusRow = () => screen.queryByRole('group', { name: 'Add a minus card' })

  it('offers Undo bust, the score so far and every minus card', async () => {
    await renderActive({ roundScores: [myBust({ final_score: -6, cards: [minus(6)] })] })

    expect(screen.getByRole('button', { name: 'Undo bust' })).toBeInTheDocument()
    expect(screen.getByText('Score so far: −6')).toBeInTheDocument()
    for (const value of [2, 4, 6, 8, 10]) {
      expect(within(minusRow()).getByRole('button', { name: `Add −${value}` })).toBeInTheDocument()
    }
  })

  it('lists the minus cards applied, without a duplicate bust\'s numbers or a way to remove them here', async () => {
    await renderActive({ roundScores: [myBust({ final_score: -6, cards: [number(5), number(5), minus(2), minus(4)] })] })

    const applied = within(screen.getByRole('region', { name: 'Applied to you' }))
    expect(applied.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['−2', '−4'])
    expect(applied.queryByRole('button')).not.toBeInTheDocument()
  })

  it('says when none are applied', async () => {
    await renderActive({ roundScores: [myBust()] })

    expect(within(screen.getByRole('region', { name: 'Applied to you' })).getByText('None yet')).toBeInTheDocument()
  })

  it('a tap adds that card', async () => {
    const props = await renderActive({ roundScores: [myBust()] })

    fireEvent.click(within(minusRow()).getByRole('button', { name: 'Add −4' }))

    expect(props.game.scoreEntry.addMinusCard).toHaveBeenCalledWith('4')
  })

  it('the buttons wait while a card is on its way', async () => {
    const props = await renderActive({ roundScores: [myBust()], busy: { addMinusCard: true } })
    const button = within(minusRow()).getByRole('button', { name: 'Add −4' })

    expect(button).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(button)

    expect(props.game.scoreEntry.addMinusCard).not.toHaveBeenCalled()
  })

  it('the tapped button keeps focus while its card is on its way', async () => {
    const props = await renderActive({ roundScores: [myBust()] })
    const button = within(minusRow()).getByRole('button', { name: 'Add −4' })
    button.focus()

    props.update({ busy: { addMinusCard: true } })

    expect(document.activeElement).toBe(button)
    expect(button).not.toBeDisabled()
  })

  it('Undo bust waits for a card on its way, or the retract would lose it', async () => {
    await renderActive({ roundScores: [myBust()], busy: { addMinusCard: true } })

    expect(screen.getByRole('button', { name: 'Undo bust' })).toBeDisabled()
  })

  it('the score so far is a polite live region, saying "minus" in words', async () => {
    const props = await renderActive({ roundScores: [myBust()] })
    const region = screen.getByText('Score so far: 0').closest('[aria-live="polite"]')
    expect(region).toHaveTextContent('Your score so far is 0')

    props.update({ roundScores: [myBust({ final_score: -6, cards: [minus(6)] })] })

    expect(screen.getByText('Score so far: −6').closest('[aria-live="polite"]')).toBe(region)
    expect(screen.getByText('Score so far: −6')).toHaveAttribute('aria-hidden', 'true')
    expect(region).toHaveTextContent('Your score so far is minus 6')
  })

  it('says how to fix a wrong card once there is one', async () => {
    const props = await renderActive({ roundScores: [myBust()] })
    expect(screen.queryByText(/Undo bust opens your cards/)).not.toBeInTheDocument()

    props.update({ roundScores: [myBust({ final_score: -6, cards: [minus(6)] })] })

    expect(screen.getByText(/Wrong card\? Undo bust opens your cards/)).toBeInTheDocument()
  })

  it('a score that isn\'t a bust gets no row', async () => {
    await renderActive({ roundScores: [myBust({ busted: false, final_score: 20 })] })

    expect(minusRow()).not.toBeInTheDocument()
    expect(screen.queryByText(/Score so far/)).not.toBeInTheDocument()
  })

  it.each(['classic', 'vengeance'])('%s has no row and no score so far', async (gameMode) => {
    await renderActive({ room: { game_mode: gameMode }, theme: { mode: gameMode }, roundScores: [myBust()] })

    expect(minusRow()).not.toBeInTheDocument()
    expect(screen.queryByText(/Score so far/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Undo bust' })).toBeInTheDocument()
  })

  it('reminds a player their cards can still change', async () => {
    await renderActive({ roundScores: [myBust()] })

    expect(screen.getByText(getRules('brutal').submittedReminder)).toBeInTheDocument()
  })
})

describe('the entry screens get their rivals from the room', () => {
  const me = makePlayer('p1', { name: 'Me' })
  const draft = { isOpen: true, pendingCards: FLIP_SEVEN, pendingAttackPlayerId: 'p2' }

  it('manual entry', async () => {
    await renderActive({ me, scoreEntry: { ...draft, showManualEntry: true } })

    expect(screen.getByRole('radio', { name: FROM_SAM })).toBeChecked()
    expect(screen.queryByRole('radio', { name: '−15 from Me' })).not.toBeInTheDocument()
  })

  it('the scanner', async () => {
    await renderActive({ me, scoreEntry: { ...draft, showScanner: true } })

    expect(screen.getByRole('radio', { name: FROM_SAM })).toBeChecked()
  })
})

// --- The mode's look and words --------------------------------------------------

describe('Brutal in the logo, picker and rules', () => {
  it('the logo carries a BRUTAL tag, so colour is not the only signal', () => {
    render(<GameLogo mode="brutal" />)

    expect(screen.getByText('Brutal')).toHaveClass('uppercase')
    expect(screen.getByText('Vengeance')).toBeInTheDocument()
  })

  // Below this the tag can't be read, and it is all that tells Brutal's logo from Vengeance's.
  it.each(['tiny', 'small', 'medium', 'large'])('the %s logo\'s tag stays legible', (size) => {
    render(<GameLogo mode="brutal" size={size} />)

    const tagClasses = screen.getByText('Brutal').className
    const pixels = tagClasses.match(/text-\[(\d+)px\]/)
    if (pixels) {
      expect(Number(pixels[1])).toBeGreaterThanOrEqual(10)
    } else {
      expect(tagClasses).toContain('text-xs')
    }
  })

  it('every other mode has no tag', () => {
    render(<GameLogo mode="vengeance" />)

    expect(screen.queryByText('Brutal')).not.toBeInTheDocument()
  })

  it('the logo button names the mode', () => {
    render(<RoomHeader room={makeRoom({ status: 'waiting', game_mode: 'brutal' })} themeMode="brutal" isHost setGameMode={vi.fn()} />)

    expect(screen.getByRole('button', { name: /^Flip Vengeance Brutal\. Game mode: Brutal\. Change mode$/ })).toBeInTheDocument()
  })

  it('the picker offers Brutal with its tagline and highlights, and selecting it applies', async () => {
    const setGameMode = vi.fn()
    const user = userEvent.setup()
    render(<RoomHeader room={makeRoom({ status: 'waiting' })} themeMode="classic" isHost setGameMode={setGameMode} />)

    await user.click(screen.getByRole('button', { name: /Change mode$/ }))
    const row = await screen.findByRole('radio', { name: 'Brutal' })

    expect(row).toHaveAccessibleDescription(expect.stringContaining('Vengeance with no mercy'))
    expect(row).toHaveAccessibleDescription(expect.stringContaining('Flip 7: +15 for you or −15 for a rival'))

    await user.click(row)
    expect(setGameMode).toHaveBeenCalledWith('brutal')
  })

  it('guests get the name and no picker', () => {
    render(<RoomHeader room={makeRoom({ status: 'waiting', game_mode: 'brutal' })} themeMode="brutal" />)

    expect(screen.getByLabelText('Game mode: Brutal')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Change mode$/ })).not.toBeInTheDocument()
  })

  it('the rules sheet has a Brutal tab that opens on this game and shows only what differs', async () => {
    const user = userEvent.setup()
    render(<RulesButton gameMode="brutal" maxScore={150} />)

    await user.click(screen.getByRole('button', { name: 'Rules' }))
    const dialog = await screen.findByRole('dialog')

    const tab = within(dialog).getByRole('tab', { name: /Brutal/ })
    expect(tab).toHaveAttribute('aria-selected', 'true')
    expect(within(tab).getByText('This game')).toBeInTheDocument()
    expect(within(dialog).getByText(/below 0/)).toBeInTheDocument()
    expect(within(dialog).queryByText(/Lucky 13/)).not.toBeInTheDocument()
  })

  it('a shift into Brutal plays Brutal\'s mood', () => {
    render(<ModeShift shift={{ id: 1, from: 'classic', to: 'brutal', coverMs: 280, fadeMs: 320, isCrossFade: false, isCovered: false }} />)

    const layer = screen.getByTestId('mode-shift')
    expect(layer.style.background).toContain('radial-gradient')
    expect(layer).toHaveAttribute('aria-hidden', 'true')
    expect(layer).toHaveClass('pointer-events-none')
  })
})
