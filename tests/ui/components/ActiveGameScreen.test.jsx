// ActiveGameScreen: the round actions before and after I submit, and the host's controls.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ActiveGameScreen from '@/pages/gameRoom/ActiveGameScreen'
import { makePlayer, ROOM_ID } from '../fixtures/renderGameHook.jsx'
import { renderRoomScreen } from '../fixtures/renderRoomScreen.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

function renderActive({ me = makePlayer('p1'), others = [makePlayer('p2', { turn_order: 1 })], ...options }) {
  return renderRoomScreen(ActiveGameScreen, { me, others, ...options })
}

const OPEN_SCANNER = {
  scoreEntry: { showScanner: true, isOpen: true },
  scanModels: { enabled: true, models: [{ id: 'flash', display_name: 'Flash' }] },
}

describe('ActiveGameScreen: chat mute hides the chat buttons (X44)', () => {
  const me = makePlayer('p1')
  const others = [makePlayer('p2', { turn_order: 1 })]
  const quickSends = [{ emoji: '❤️', message: '', toEveryone: true }]

  it('shows the chat button and, a tap away, the quick sends while unmuted', async () => {
    await renderActive({ me, others, chat: { quickSends, isMuted: false } })

    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    expect(await screen.findByTitle('❤️')).toBeInTheDocument()
  })

  it('eases the room left under the quick sends as they unfold, rather than jumping', async () => {
    // Four reach above the toggles on the right, so the clearance changes.
    const fourQuickSends = ['❤️', '🎉', '🔥', '👏'].map((emoji) => ({ emoji, message: '', toEveryone: true }))
    await renderActive({ me, others, chat: { quickSends: fourQuickSends, isMuted: false } })
    const page = screen.getByRole('button', { name: 'Chat' }).closest('.game-screen-bg')
    const foldedPadding = page.style.paddingBottom

    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    await screen.findByTitle('❤️')

    expect(page.style.paddingBottom).not.toBe(foldedPadding)
    expect(page).toHaveClass('transition-[padding-bottom]', 'motion-reduce:transition-none')
  })

  it('shows neither when the screen opens already muted', async () => {
    await renderActive({ me, others, chat: { quickSends, isMuted: true } })

    expect(screen.getByRole('button', { name: /^bust/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Chat' })).not.toBeInTheDocument()
    expect(screen.queryByTitle('❤️')).not.toBeInTheDocument()
  })

  it('removes them after muting and brings them back after unmuting', async () => {
    const view = await renderActive({ me, others, chat: { quickSends, isMuted: false } })
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    await screen.findByTitle('❤️')

    view.update({ chat: { isMuted: true } })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Chat' })).not.toBeInTheDocument()
    })
    await waitFor(() => {
      expect(screen.queryByTitle('❤️')).not.toBeInTheDocument()
    })

    view.update({ chat: { isMuted: false } })
    expect(await screen.findByRole('button', { name: 'Chat' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    expect(await screen.findByTitle('❤️')).toBeInTheDocument()
  })
})

describe('ActiveGameScreen: the quick sends fold into the chat button (X79)', () => {
  const me = makePlayer('p1')
  const others = [makePlayer('p2', { turn_order: 1 })]

  function renderWithQuickSends(quickSends = [{ emoji: '❤️', message: '', recipients: [], toEveryone: true }]) {
    window.localStorage.setItem(`quick_sends_${ROOM_ID}`, JSON.stringify(quickSends))
    return renderActive({ me, others })
  }

  afterEach(() => {
    window.localStorage.clear()
  })

  it('start folded away', async () => {
    await renderWithQuickSends()

    expect(screen.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTitle('❤️')).not.toBeInTheDocument()
  })

  it('one tap opens them, without the chat dialog, and a second tap folds them again', async () => {
    await renderWithQuickSends()
    const chatButton = screen.getByRole('button', { name: 'Chat' })

    fireEvent.click(chatButton)
    expect(await screen.findByTitle('❤️')).toBeInTheDocument()
    expect(chatButton).toHaveAttribute('aria-expanded', 'true')
    expect(screen.queryByPlaceholderText('Type a message...')).not.toBeInTheDocument()

    // Past the double-tap window, so this is a second single tap.
    await new Promise((resolve) => setTimeout(resolve, 350))
    fireEvent.click(chatButton)
    await waitFor(() => expect(screen.queryByTitle('❤️')).not.toBeInTheDocument())
  })

  it('sending a quick send folds them away', async () => {
    await renderWithQuickSends()
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))

    fireEvent.click(await screen.findByTitle('❤️'))

    await waitFor(() => expect(screen.queryByTitle('❤️')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('a double tap opens the chat dialog and leaves them folded', async () => {
    await renderWithQuickSends()
    const chatButton = screen.getByRole('button', { name: 'Chat' })

    fireEvent.click(chatButton)
    fireEvent.click(chatButton)

    expect(await screen.findByPlaceholderText('Type a message...')).toBeInTheDocument()
    expect(screen.queryByTitle('❤️')).not.toBeInTheDocument()
    expect(chatButton).toHaveAttribute('aria-expanded', 'false')
  })

  it('a double tap while they are open opens the dialog and folds them', async () => {
    await renderWithQuickSends()
    const chatButton = screen.getByRole('button', { name: 'Chat' })
    fireEvent.click(chatButton)
    await screen.findByTitle('❤️')
    await new Promise((resolve) => setTimeout(resolve, 350))

    fireEvent.click(chatButton)
    fireEvent.click(chatButton)

    expect(await screen.findByPlaceholderText('Type a message...')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByTitle('❤️')).not.toBeInTheDocument())
  })

  it('with no quick sends saved, one tap opens the chat dialog', async () => {
    await renderWithQuickSends([])

    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))

    expect(await screen.findByPlaceholderText('Type a message...')).toBeInTheDocument()
  })

  it('one tap while the dialog is open closes it', async () => {
    await renderWithQuickSends()
    const chatButton = screen.getByRole('button', { name: 'Chat' })
    fireEvent.click(chatButton)
    fireEvent.click(chatButton)
    await screen.findByPlaceholderText('Type a message...')
    await new Promise((resolve) => setTimeout(resolve, 350))

    fireEvent.click(chatButton)

    await waitFor(() => expect(screen.queryByPlaceholderText('Type a message...')).not.toBeInTheDocument())
    expect(screen.queryByTitle('❤️')).not.toBeInTheDocument()
  })
})

describe('ActiveGameScreen: the Rules button', () => {
  it('sits at the bottom of the page, after the score buttons and the players panel', async () => {
    await renderActive({})

    const rules = screen.getByRole('button', { name: 'Rules' })
    const bust = screen.getByRole('button', { name: /^bust/i })
    const leave = screen.getByRole('button', { name: /leave/i })

    expect(bust.compareDocumentPosition(rules) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(leave.compareDocumentPosition(rules) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('ActiveGameScreen: the Scan tile when scanning isn\'t set up', () => {
  it('fades and says so, but still opens the scanner, which explains', async () => {
    const props = await renderActive({ scanModels: { enabled: false } })

    const scan = screen.getByRole('button', { name: 'Scan Cards (not set up on this server)' })
    expect(scan).toHaveClass('opacity-50')
    expect(scan).toBeEnabled()
    fireEvent.click(scan)
    expect(props.game.scoreEntry.openScoreEntry).toHaveBeenCalledWith('scanner')
  })

  it('stays as it is while the setup is loading, and once it is set up', async () => {
    await renderActive({ scanModels: { enabled: null } })
    expect(screen.getByRole('button', { name: 'Scan Cards' })).not.toHaveClass('opacity-50')
  })
})

describe('ActiveGameScreen: my round', () => {
  it('shows Scan, Manual and Bust before I submit, and wires them up', async () => {
    const props = await renderActive({})

    fireEvent.click(screen.getByRole('button', { name: /^bust/i }))
    fireEvent.click(screen.getByRole('button', { name: /^scan/i }))
    fireEvent.click(screen.getByRole('button', { name: /enter score manually/i }))

    expect(props.game.scoreEntry.bust).toHaveBeenCalledTimes(1)
    expect(props.game.scoreEntry.openScoreEntry).toHaveBeenCalledWith('scanner')
    expect(props.game.scoreEntry.openScoreEntry).toHaveBeenCalledWith('manual')
    expect(screen.queryByText('Score submitted!')).not.toBeInTheDocument()
  })

  it('after I submit, shows a waiting state instead of the entry buttons', async () => {
    await renderActive({
      me: makePlayer('p1', { has_submitted_round: true }),
      others: [makePlayer('p2', { turn_order: 1 })],
    })

    expect(screen.getByText('Score submitted!')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /change score|undo bust/i })).not.toBeInTheDocument()
    expect(screen.getByText('Waiting for 1 player')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^bust/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^scan/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /enter score manually/i })).not.toBeInTheDocument()
  })

  it('the Bust tile is named just "Bust", as its score depends on the mode', async () => {
    await renderActive({})

    expect(screen.getByRole('button', { name: 'Bust' })).toBeInTheDocument()
  })

  describe('the submitted panel (X45)', () => {
    const submitted = makePlayer('p1', { has_submitted_round: true })

    function stored(fields) {
      return { id: 's1', player_id: 'p1', round_number: 1, final_score: 24, cards: [], ...fields }
    }

    it('a score: says what was entered and offers Change score', async () => {
      const props = await renderActive({ me: submitted, roundScores: [stored({})] })

      expect(screen.getByText('Score submitted: 24')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Change score' }))

      expect(props.game.scoreEntry.takeBackScore).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('button', { name: 'Undo bust' })).not.toBeInTheDocument()
    })

    it('a bust: says so and offers Undo bust', async () => {
      const props = await renderActive({
        me: submitted,
        roundScores: [stored({ final_score: 0, busted: true })],
      })

      expect(screen.getByText('You busted this round')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Undo bust' }))

      expect(props.game.scoreEntry.takeBackScore).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('button', { name: 'Change score' })).not.toBeInTheDocument()
    })

    it('a score from an earlier round doesn\'t count', async () => {
      await renderActive({ me: submitted, roundScores: [stored({ round_number: 7 })] })

      expect(screen.getByText('Score submitted!')).toBeInTheDocument()
    })

    it('the action is disabled while the retract is running', async () => {
      await renderActive({ me: submitted, roundScores: [stored({})], busy: { retractScore: true } })

      expect(screen.getByRole('button', { name: 'Change score' })).toBeDisabled()
    })

    it('Vengeance reminds the player that cards can still change', async () => {
      await renderActive({ me: submitted, roundScores: [stored({})], room: { game_mode: 'vengeance' } })

      expect(screen.getByText('If your cards change before the round ends, change your score.')).toBeInTheDocument()
    })

    it('Classic has no such reminder', async () => {
      await renderActive({ me: submitted, roundScores: [stored({})] })

      expect(screen.queryByText(/If your cards change/)).not.toBeInTheDocument()
    })

    it('other players\' waiting list still shows', async () => {
      await renderActive({ me: submitted, roundScores: [stored({})] })

      expect(screen.getByText('Waiting for 1 player')).toBeInTheDocument()
    })

    describe('scrolling to the turn card after entering a score (X47)', () => {
      const TURN_CARD_TOP = 320

      afterEach(() => {
        vi.restoreAllMocks()
      })

      // jsdom has no layout: put the game card, whose top is the turn card, 320px down and everything
      // else at 0, so a scroll aimed at it is the only one asking for top: 320. The scoreboard also
      // scrolls itself, sideways (`left`), to show the latest round.
      function spyOnScrolls() {
        const rect = Element.prototype.getBoundingClientRect
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
          if (this.matches('[data-game-card]')) {
            return { ...rect.call(this), top: TURN_CARD_TOP }
          }
          return rect.call(this)
        })
        const scrollTo = vi.spyOn(Element.prototype, 'scrollTo')
        const vertical = () => scrollTo.mock.calls.filter(([options]) => options.top !== undefined)
        return {
          toTurnCard: () => vertical().filter(([options]) => options.top === TURN_CARD_TOP),
          elsewhere: () => vertical().filter(([options]) => options.top !== TURN_CARD_TOP),
        }
      }

      it('brings the turn card to the top for the score just entered, and only asks once', async () => {
        const scrolls = spyOnScrolls()
        const props = await renderActive({
          me: submitted,
          roundScores: [stored({})],
          scoreEntry: { enteredScoreRound: 1 },
        })

        expect(screen.getByText('Current Turn').closest('[data-game-card]')).not.toBeNull()
        expect(scrolls.toTurnCard()).toHaveLength(1)
        expect(scrolls.elsewhere()).toHaveLength(0)
        expect(props.game.scoreEntry.clearEnteredScoreRound).toHaveBeenCalledTimes(1)
      })

      it('also when that score closed the round, so the tiles are back', async () => {
        const scrolls = spyOnScrolls()
        const props = await renderActive({ room: { current_round: 2 }, scoreEntry: { enteredScoreRound: 1 } })

        expect(screen.getByRole('button', { name: /^bust/i })).toBeInTheDocument()
        expect(scrolls.toTurnCard()).toHaveLength(1)
        expect(props.game.scoreEntry.clearEnteredScoreRound).toHaveBeenCalledTimes(1)
      })

      it('stays put when the screen opens on a score already in, as after a reload', async () => {
        const scrolls = spyOnScrolls()
        await renderActive({ me: submitted, roundScores: [stored({})], scoreEntry: { enteredScoreRound: null } })

        expect(scrolls.toTurnCard()).toHaveLength(0)
        expect(scrolls.elsewhere()).toHaveLength(0)
      })

      it('a bust goes to the turn card like any other score', async () => {
        const scrolls = spyOnScrolls()
        await renderActive({
          me: submitted,
          roundScores: [stored({ busted: true, final_score: 0 })],
          scoreEntry: { enteredScoreRound: 1 },
        })

        expect(screen.getByText('You busted this round')).toBeInTheDocument()
        expect(scrolls.toTurnCard()).toHaveLength(1)
        expect(scrolls.elsewhere()).toHaveLength(0)
      })

      // Under the turn card, a short phone's floating buttons cover Add −2 (X43), so its panel keeps the top.
      it('a Brutal bust, which takes minus cards, stays on its own panel', async () => {
        const scrolls = spyOnScrolls()
        const props = await renderActive({
          me: submitted,
          room: { game_mode: 'brutal' },
          roundScores: [stored({ busted: true, final_score: 0 })],
          scoreEntry: { enteredScoreRound: 1 },
        })

        expect(screen.getByRole('button', { name: 'Add −2' })).toBeInTheDocument()
        expect(scrolls.toTurnCard()).toHaveLength(0)
        expect(scrolls.elsewhere()).toHaveLength(1)
        expect(props.game.scoreEntry.clearEnteredScoreRound).toHaveBeenCalledTimes(1)
      })
    })
  })

  it('disables the entry buttons while a score is being submitted', async () => {
    await renderActive({ busy: { submitScore: true } })

    expect(screen.getByRole('button', { name: /submitting/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^scan/i })).toBeDisabled()
  })

  it('marks my row on the scoreboard', async () => {
    await renderActive({ me: makePlayer('p1', { name: 'Me' }), others: [makePlayer('p2', { name: 'Other', turn_order: 1 })] })

    const myRow = screen.getByRole('row', { current: true })
    expect(myRow).toHaveTextContent('Me')
    expect(myRow).toHaveTextContent('You')
  })

  it('tells non-host players the host is editing scores', async () => {
    await renderActive({ room: { is_edit_mode: true } })

    expect(screen.getByText('Host is editing scores')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^bust/i })).not.toBeInTheDocument()
  })
})

describe('ActiveGameScreen: host', () => {
  const host = makePlayer('p1', { is_host: true })

  it('sees Force Next Round, Edit Scores and End Game Now', async () => {
    const props = await renderActive({ isHost: true, me: host })

    fireEvent.click(screen.getByRole('button', { name: /force next round/i }))
    fireEvent.click(screen.getByRole('button', { name: /edit scores/i }))
    fireEvent.click(screen.getByRole('button', { name: /end game now/i }))

    expect(props.game.host.forceNextRound).toHaveBeenCalledTimes(1)
    expect(props.game.host.setEditMode).toHaveBeenCalledWith(true)
    expect(props.game.host.endGame).toHaveBeenCalledTimes(1)
  })

  it('does not offer Force Next Round once everyone has submitted', async () => {
    await renderActive({
      isHost: true,
      me: makePlayer('p1', { is_host: true, has_submitted_round: true }),
      others: [makePlayer('p2', { turn_order: 1, has_submitted_round: true })],
    })

    expect(screen.queryByRole('button', { name: /force next round/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /end game now/i })).toBeInTheDocument()
  })

  it('other players see none of the host controls', async () => {
    await renderActive({ isHost: false })

    expect(screen.queryByRole('button', { name: /force next round/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /edit scores/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /end game now/i })).not.toBeInTheDocument()
  })
})

// The entering-cards indicator. The screen takes the
// other players who are entering as `enteringPlayers` ([{ id, name, state }], already without
// me); useEnteringPlayers works that out and hides it when my own connection is down.
describe('ActiveGameScreen: entering-cards indicator', () => {
  const sam = { id: 'p2', name: 'Sam', state: 'scanning' }
  const jo = { id: 'p3', name: 'Jo', state: 'typing' }
  const kim = { id: 'p4', name: 'Kim', state: 'typing' }

  it('shows nothing extra when nobody is entering', async () => {
    await renderActive({ scoreEntry: { enteringPlayers: [] } })

    expect(screen.queryByText(/hold on/i)).not.toBeInTheDocument()
    expect(screen.getByText('Current Turn')).toBeInTheDocument()
  })

  it('names one person who is scanning', async () => {
    await renderActive({ scoreEntry: { enteringPlayers: [sam] } })

    expect(screen.getByText(/Hold on, Sam is scanning cards/)).toBeInTheDocument()
  })

  it('names one person who is typing', async () => {
    await renderActive({ scoreEntry: { enteringPlayers: [{ ...sam, state: 'typing' }] } })

    expect(screen.getByText(/Hold on, Sam is entering cards/)).toBeInTheDocument()
  })

  it('names two people', async () => {
    await renderActive({ scoreEntry: { enteringPlayers: [sam, jo] } })

    expect(screen.getByText(/Hold on, Sam and Jo are entering cards/)).toBeInTheDocument()
  })

  it('counts three or more people', async () => {
    await renderActive({ scoreEntry: { enteringPlayers: [sam, jo, kim] } })

    expect(screen.getByText(/Hold on, 3 players are entering cards/)).toBeInTheDocument()
  })

  it('announces itself politely to screen readers and never blocks the buttons', async () => {
    await renderActive({ scoreEntry: { enteringPlayers: [sam] } })

    const message = screen.getByText(/Hold on, Sam is scanning cards/)
    expect(message.closest('[aria-live]')).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByRole('button', { name: /^scan/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /^bust/i })).toBeEnabled()
  })

  it('pulses, except for people who prefer reduced motion', async () => {
    await renderActive({ scoreEntry: { enteringPlayers: [sam] } })

    const pill = screen.getByText(/Hold on, Sam is scanning cards/).closest('.animate-pulse')
    expect(pill).not.toBeNull()
    expect(pill).toHaveClass('motion-reduce:animate-none')
  })

  it('keeps the current turn card when someone is entering', async () => {
    await renderActive({ scoreEntry: { enteringPlayers: [sam] } })

    expect(screen.getByRole('group', { name: 'Current Turn' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Next Up' })).toBeInTheDocument()
  })
})

// Once a round is under way the table needs to know who starts the next one (X48).
describe('ActiveGameScreen: turn card highlights the next dealer', () => {
  const me = makePlayer('p1', { name: 'Ana' })
  const sam = makePlayer('p2', { name: 'Sam', turn_order: 1 })
  const samEntering = { id: 'p2', name: 'Sam', state: 'typing' }

  // A player's name is also on the scoreboard and in the players panel, so each is read from its slot.
  function slot(label) {
    return screen.getByRole('group', { name: label })
  }

  function nameIn(label) {
    return within(slot(label)).getByText(/./, { selector: 'p:last-child' })
  }

  function expectNextDealerHighlighted() {
    expect(slot('Current Turn')).toHaveClass('opacity-50')
    expect(slot('Next Up')).not.toHaveClass('opacity-50')
    expect(nameIn('Next Up')).toHaveTextContent('Sam')
    expect(nameIn('Next Up')).toHaveClass('animate-pulse', 'motion-reduce:animate-none')
  }

  it('shows Next Up beside the current dealer, in the same row', async () => {
    await renderActive({ me, others: [sam] })

    expect(slot('Current Turn').parentElement).toBe(slot('Next Up').parentElement)
    expect(slot('Current Turn').parentElement).toHaveClass('grid')
  })

  it('leaves the current dealer highlighted before the round is under way', async () => {
    await renderActive({ me, others: [sam] })

    expect(nameIn('Current Turn')).toHaveTextContent('Ana')
    expect(nameIn('Current Turn')).toHaveClass('text-ui-accent-strong')
    expect(slot('Current Turn')).not.toHaveClass('opacity-50')
    expect(slot('Next Up')).toHaveClass('opacity-50')
    expect(nameIn('Next Up')).not.toHaveClass('animate-pulse')
  })

  it('switches when another player is entering cards', async () => {
    await renderActive({ me, others: [sam], scoreEntry: { enteringPlayers: [samEntering] } })

    expectNextDealerHighlighted()
  })

  it('switches when I have manual entry open', async () => {
    await renderActive({ me, others: [sam], scoreEntry: { showManualEntry: true, isOpen: true } })

    expectNextDealerHighlighted()
  })

  it('switches when I have the scanner open', async () => {
    await renderActive({ me, others: [sam], ...OPEN_SCANNER })

    expectNextDealerHighlighted()
  })

  it('switches when a player has submitted', async () => {
    await renderActive({ me, others: [{ ...sam, has_submitted_round: true }] })

    expectNextDealerHighlighted()
  })
})

// The camera can kill the socket, so the server has to hear "scanning" before the picker opens.
describe('ActiveGameScreen: scanner announces scanning', () => {
  function renderScanner() {
    return renderActive(OPEN_SCANNER)
  }

  it('tapping Tap to capture cards calls startScanning', async () => {
    const props = await renderScanner()

    fireEvent.click(screen.getByRole('button', { name: /tap to capture cards/i }))

    expect(props.game.scoreEntry.startScanning).toHaveBeenCalledTimes(1)
  })

  it('tapping Choose from photos calls startScanning', async () => {
    const props = await renderScanner()

    fireEvent.click(screen.getByRole('button', { name: /choose from photos/i }))

    expect(props.game.scoreEntry.startScanning).toHaveBeenCalledTimes(1)
  })
})

describe('ActiveGameScreen: the game mode (X41)', () => {
  const manualEntry = { scoreEntry: { showManualEntry: true, isOpen: true, pendingCards: [{ type: 'number', value: '5' }] } }

  it('the host can change mode before the first score', async () => {
    await renderActive({ isHost: true })

    expect(screen.getByRole('button', { name: /Change mode/ })).toBeInTheDocument()
  })

  it('a score locks it to a read-only name', async () => {
    await renderActive({ isHost: true, roundScores: [{ id: 's1', player_id: 'p1', round_number: 1, final_score: 3 }] })

    expect(screen.queryByRole('button', { name: /Change mode/ })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Game mode: Classic')).toBeInTheDocument()
  })

  it('passes the mode to the entry screen', async () => {
    await renderActive({ ...manualEntry, room: { game_mode: 'vengeance' } })

    expect(screen.getByRole('button', { name: 'Lucky 13' })).toBeInTheDocument()
  })

  it('a shift during open card entry keeps its values and focus', async () => {
    const view = await renderActive(manualEntry)
    const input = await screen.findByRole('spinbutton', { name: 'Card 1 value' })
    fireEvent.change(input, { target: { value: '9' } })
    input.focus()

    view.update({ room: { game_mode: 'vengeance' }, theme: { mode: 'vengeance' } })

    const same = screen.getByRole('spinbutton', { name: 'Card 1 value' })
    expect(same).toBe(input)
    expect(same).toHaveValue(9)
    expect(same).toHaveFocus()
  })
})

// Back from an entry screen lands on the scoreboard's top, wherever the screen was scrolled (X76).
describe('ActiveGameScreen: Back from an entry screen returns to the scoreboard (X76)', () => {
  const SCOREBOARD_TOP = 480

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // jsdom has no layout: put the scoreboard 480px down and everything else at 0, so a scroll aimed
  // at the scoreboard is the only one asking for top: 480. While an entry screen is open the turn card
  // above it highlights the next dealer (the pulse), which can change its height, so until the render
  // that closes the entry the scoreboard sits lower here and a scroll measured too early misses.
  function placeScoreboard() {
    const rect = Element.prototype.getBoundingClientRect
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.matches('[data-scoreboard]')) {
        const turnCardIsTaller = document.querySelector('.animate-pulse') !== null
        return { ...rect.call(this), top: turnCardIsTaller ? SCOREBOARD_TOP + 8 : SCOREBOARD_TOP }
      }
      return rect.call(this)
    })
    const scrollTo = vi.spyOn(Element.prototype, 'scrollTo')
    return () => scrollTo.mock.calls.filter(([options]) => options.top === SCOREBOARD_TOP)
  }

  // The overrides hold the entry open, so closing it lays the closed state over them in the same
  // tap, as the real closeScoreEntry's state change would.
  async function renderOpenEntry({ scoreEntry, ...options }) {
    let view
    const closeScoreEntry = vi.fn(() => {
      view.update({ scoreEntry: { showManualEntry: false, showScanner: false, isOpen: false } })
    })
    view = await renderActive({ ...options, scoreEntry: { ...scoreEntry, closeScoreEntry } })
    return closeScoreEntry
  }

  it('from manual entry', async () => {
    const scrollsToScoreboard = placeScoreboard()
    const closeScoreEntry = await renderOpenEntry({ scoreEntry: { showManualEntry: true, isOpen: true } })
    expect(scrollsToScoreboard()).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: /back/i }))

    expect(closeScoreEntry).toHaveBeenCalledTimes(1)
    expect(scrollsToScoreboard()).toHaveLength(1)
  })

  it('from the scanner', async () => {
    const scrollsToScoreboard = placeScoreboard()
    const closeScoreEntry = await renderOpenEntry(OPEN_SCANNER)
    expect(scrollsToScoreboard()).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: /back/i }))

    expect(closeScoreEntry).toHaveBeenCalledTimes(1)
    expect(scrollsToScoreboard()).toHaveLength(1)
  })
})
