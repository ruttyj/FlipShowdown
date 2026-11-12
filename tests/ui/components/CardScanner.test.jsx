import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import CardScanner from '@/components/game/CardScanner'
import { SoundProvider } from '@/components/useSound'
import { aiModule } from '../fixtures/fakeApi.jsx'

vi.mock('@/api/game', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.gameModule))
vi.mock('@/api/backend', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.backendModule))
vi.mock('@/api/ai', () => import('../fixtures/fakeApi.jsx').then((fakes) => fakes.aiModule))

const MODELS = [
  { id: 'flash', display_name: 'Flash' },
  { id: 'pro', display_name: 'Pro' },
]

const PHOTO = new File(['x'], 'cards.jpg', { type: 'image/jpeg' })

// Replaces the browser's image decoding: every Image either loads or fails, as chosen.
function stubImageDecoding({ decodes }) {
  class FakeImage {
    width = 2000
    height = 1000
    set src(_url) {
      queueMicrotask(() => (decodes ? this.onload() : this.onerror()))
    }
  }
  vi.stubGlobal('Image', FakeImage)
  URL.createObjectURL = vi.fn(() => 'blob:photo')
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,AAAA')
}

function renderScanner(props = {}) {
  const handlers = {
    onCardsChange: vi.fn(),
    onCardsConfirmed: vi.fn(),
    onCancel: vi.fn(),
    onManualEntry: vi.fn(),
    setCurrentModel: vi.fn(),
  }
  const scanner = (currentProps) => (
    <SoundProvider>
      <CardScanner aiEnabled modelList={MODELS} {...handlers} {...currentProps} />
    </SoundProvider>
  )
  const { rerender } = render(scanner(props))
  return { ...handlers, user: userEvent.setup(), rerenderWith: (nextProps) => rerender(scanner(nextProps)) }
}

// The second file input is "Choose from photos"; the labelled buttons only click it.
async function choosePhoto(user) {
  const inputs = document.querySelectorAll('input[type="file"]')
  await user.upload(inputs[1], PHOTO)
}

const confirmButton = () => screen.getByRole('button', { name: /confirm score/i })

beforeEach(() => {
  aiModule.scanCards.mockReset()
  stubImageDecoding({ decodes: true })
  Element.prototype.scrollIntoView = vi.fn()
  vi.spyOn(toast, 'error').mockImplementation(() => 'id')
  vi.spyOn(toast, 'warning').mockImplementation(() => 'id')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function cardsOfCount(count) {
  return Array.from({ length: count }, (_, index) => ({ type: 'number', value: String(index) }))
}

describe('CardScanner', () => {
  // --- The card limit ---

  // A scan may return up to 40 cards, but the server refuses more than 30.
  it('disables Confirm and says why when a scan returns more than 30 cards', async () => {
    aiModule.scanCards.mockResolvedValue({ cards: cardsOfCount(31), model: 'flash' })
    const { user } = renderScanner()

    await choosePhoto(user)

    expect(await screen.findByRole('alert')).toHaveTextContent('at most 30 cards')
    expect(confirmButton()).toBeDisabled()
  })

  it('keeps Confirm enabled at exactly 30 cards', async () => {
    aiModule.scanCards.mockResolvedValue({ cards: cardsOfCount(30), model: 'flash' })
    const { user } = renderScanner()

    await choosePhoto(user)

    expect(await screen.findByRole('spinbutton', { name: 'Card 30 value' })).toBeInTheDocument()
    expect(confirmButton()).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  // --- Scanning ---

  it('offers only manual entry when AI is disabled', async () => {
    const { user, onManualEntry } = renderScanner({ aiEnabled: false })

    expect(screen.queryByText('Tap to capture cards')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /enter score manually/i }))
    expect(onManualEntry).toHaveBeenCalled()
  })

  it('with AI disabled, cards brought over from manual entry still say why there\'s no scanning', async () => {
    const { user, onManualEntry } = renderScanner({ aiEnabled: false, initialCards: [{ type: 'number', value: '5' }] })

    expect(screen.getByText('AI card scanning isn\'t set up on this server').closest('[role="status"]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /retake photo/i })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /enter score manually/i }))
    expect(onManualEntry).toHaveBeenCalled()
  })

  it('shows a spinner during the scan, then the cards returned', async () => {
    let finishScan
    aiModule.scanCards.mockReturnValue(new Promise((resolve) => { finishScan = resolve }))
    const { user } = renderScanner()

    await choosePhoto(user)
    expect(await screen.findByText('Analyzing cards...')).toBeInTheDocument()
    expect(aiModule.scanCards).toHaveBeenCalledWith('data:image/jpeg;base64,AAAA', 'flash', 'classic')

    finishScan({ cards: [{ type: 'number', value: '5' }], model: 'flash' })
    expect(await screen.findByRole('spinbutton', { name: 'Card 1 value' })).toHaveValue(5)
    expect(screen.queryByText('Analyzing cards...')).not.toBeInTheDocument()
  })

  it('shows the JPEG or PNG error for a photo the browser cannot decode', async () => {
    stubImageDecoding({ decodes: false })
    const { user } = renderScanner()

    await choosePhoto(user)

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to analyze cards', {
      description: 'This photo format could not be opened. Try a JPEG or PNG.',
    }))
    expect(aiModule.scanCards).not.toHaveBeenCalled()
  })

  it('a scan failure shows an error toast and keeps manual entry available', async () => {
    const error = Object.assign(new Error('Bad photo'), { status: 400 })
    aiModule.scanCards.mockRejectedValue(error)
    const { user, onCancel } = renderScanner()

    await choosePhoto(user)

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to analyze cards', { description: 'Bad photo' }))
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('lists the models and changing it calls onModelChange', async () => {
    const { user, setCurrentModel } = renderScanner()

    await user.click(screen.getByRole('button', { name: 'Flash' }))
    expect(screen.getByText('Select Model')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Pro' }))

    expect(setCurrentModel).toHaveBeenCalledWith('pro')
  })

  it('scanned cards can be edited before confirming', async () => {
    aiModule.scanCards.mockResolvedValue({ cards: [{ type: 'number', value: '5' }], model: 'flash' })
    const { user, onCardsConfirmed, setCurrentModel } = renderScanner()

    await choosePhoto(user)
    const value = await screen.findByRole('spinbutton', { name: 'Card 1 value' })
    expect(setCurrentModel).toHaveBeenCalledWith('flash')
    await user.clear(value)
    await user.type(value, '9')
    await user.click(confirmButton())

    expect(onCardsConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({ cards: [{ type: 'number', value: '9' }], baseSum: 9, finalScore: 9 }),
    )
  })

  // X39: a scan result is for checking; the phone keyboard would hide the cards being checked.
  it('shows scan results with no value field focused (X39)', async () => {
    aiModule.scanCards.mockResolvedValue({
      cards: [{ type: 'number', value: '5' }, { type: 'number', value: '7' }],
      model: 'flash',
    })
    const { user } = renderScanner()

    await choosePhoto(user)

    expect(await screen.findByRole('spinbutton', { name: 'Card 2 value' })).toBeInTheDocument()
    expect(document.activeElement.tagName).not.toBe('INPUT')
  })

  it('restoring a draft focuses no value field (X39)', () => {
    renderScanner({ initialCards: [{ type: 'number', value: '5' }, { type: 'number', value: '7' }] })

    expect(screen.getByRole('spinbutton', { name: 'Card 2 value' })).toBeInTheDocument()
    expect(document.activeElement.tagName).not.toBe('INPUT')
  })

  it('removing a scanned card focuses no value field (X39)', async () => {
    const { user } = renderScanner({ initialCards: [{ type: 'number', value: '5' }, { type: 'number', value: '7' }] })

    await user.click(screen.getByRole('button', { name: 'Remove card 1' }))

    expect(screen.getAllByRole('spinbutton')).toHaveLength(1)
    expect(document.activeElement.tagName).not.toBe('INPUT')
  })

  it('an add button on scan results still focuses the new row (X39)', async () => {
    const { user } = renderScanner({ initialCards: [{ type: 'number', value: '5' }] })

    await user.click(screen.getByRole('button', { name: 'Add card' }))

    expect(screen.getByRole('spinbutton', { name: 'Card 2 value' })).toHaveFocus()
  })

  it('shows scanned modifiers without their signs (X34)', async () => {
    const cards = [
      { type: 'number', value: '5' },
      { type: 'multiplier', value: 'x2' },
      { type: 'subtractor', value: '-4' },
    ]
    aiModule.scanCards.mockResolvedValue({ cards, model: 'flash' })
    const { user, onCardsConfirmed } = renderScanner()

    await choosePhoto(user)
    expect(await screen.findByRole('spinbutton', { name: 'Card 2 value' })).toHaveValue(2)
    expect(screen.getByRole('spinbutton', { name: 'Card 3 value' })).toHaveValue(4)
    await user.click(confirmButton())

    expect(onCardsConfirmed).toHaveBeenCalledWith(expect.objectContaining({
      cards: [
        { type: 'number', value: '5' },
        { type: 'multiplier', value: '2' },
        { type: 'subtractor', value: '4' },
      ],
      finalScore: 6,
    }))
  })

  it('Back during a scan drops the late result and shows no toast', async () => {
    let finishScan
    aiModule.scanCards.mockReturnValue(new Promise((resolve) => { finishScan = resolve }))
    const { user, onCancel, setCurrentModel, onCardsChange } = renderScanner()

    await choosePhoto(user)
    await screen.findByText('Analyzing cards...')
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(onCancel).toHaveBeenCalled()

    finishScan({ cards: [{ type: 'number', value: '5' }], model: 'pro' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(setCurrentModel).not.toHaveBeenCalled()
    expect(onCardsChange).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('Back during a failing scan shows no toast', async () => {
    let failScan
    aiModule.scanCards.mockReturnValue(new Promise((_, reject) => { failScan = reject }))
    const { user } = renderScanner()

    await choosePhoto(user)
    await screen.findByText('Analyzing cards...')
    await user.click(screen.getByRole('button', { name: 'Back' }))
    failScan(new Error('late'))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(toast.error).not.toHaveBeenCalled()
  })

  describe('blank cards (X1, X2)', () => {
    it('drops blank cards of every type before confirming', async () => {
      const cards = [
        { type: 'number', value: '4' },
        { type: 'number', value: '' },
        { type: 'multiplier', value: '' },
        { type: 'divisor', value: '  ' },
        { type: 'adder', value: '' },
      ]
      const { user, onCardsConfirmed } = renderScanner({ initialCards: cards })

      await user.click(confirmButton())

      expect(onCardsConfirmed).toHaveBeenCalledWith(
        expect.objectContaining({ cards: [{ type: 'number', value: '4' }], baseSum: 4, multiplier: 1, finalScore: 4 }),
      )
    })

    it('does not floor a negative score at 0', async () => {
      const cards = [{ type: 'number', value: '2' }, { type: 'subtractor', value: '-4' }]
      const { user, onCardsConfirmed } = renderScanner({ initialCards: cards })

      await user.click(confirmButton())

      expect(onCardsConfirmed).toHaveBeenCalledWith(expect.objectContaining({ finalScore: -2 }))
    })

    it('does not bust because of blank rows', async () => {
      const cards = [
        { type: 'number', value: '0' },
        { type: 'number', value: '' },
        { type: 'number', value: '' },
      ]
      const { user, onCardsConfirmed } = renderScanner({ initialCards: cards })

      await user.click(confirmButton())

      expect(onCardsConfirmed).toHaveBeenCalledWith(
        expect.objectContaining({ cards: [{ type: 'number', value: '0' }], isDuplicateBust: false }),
      )
    })

    it('disables confirm when only blank rows remain', () => {
      renderScanner({ initialCards: [{ type: 'number', value: '' }] })

      expect(confirmButton()).toBeDisabled()
    })
  })
})

// Scan modes (X46).
describe('CardScanner: scan modes', () => {
  const WRONG_DECK = 'These look like Vengeance cards. Ask the host to switch'
  const number = (value) => ({ type: 'number', value })

  async function scanCardsInto(user, cards) {
    aiModule.scanCards.mockResolvedValue({ cards, model: 'flash' })
    await choosePhoto(user)
    await screen.findByText('Detected Cards')
  }

  it.each([
    ['vengeance', 'vengeance'],
    ['brutal', 'vengeance'],
    ['classic', 'classic'],
    [undefined, 'classic'],
    ['nonsense', 'classic'],
  ])('a room in %s asks for the %s scan', async (gameMode, scanMode) => {
    const { user } = renderScanner({ gameMode })

    await scanCardsInto(user, [number('5')])

    expect(aiModule.scanCards).toHaveBeenCalledWith('data:image/jpeg;base64,AAAA', 'flash', scanMode)
  })

  it('a fallback model is asked with the same mode', async () => {
    const failure = Object.assign(new Error('down'), { status: 502 })
    aiModule.scanCards.mockRejectedValueOnce(failure)
    const { user } = renderScanner({ gameMode: 'vengeance' })

    await scanCardsInto(user, [number('5')])

    expect(aiModule.scanCards).toHaveBeenLastCalledWith('data:image/jpeg;base64,AAAA', 'pro', 'vengeance')
  })

  it.each([
    ['a 13', { type: 'number', value: '13' }],
    ['a ÷2', { type: 'divisor', value: '÷2' }],
  ])('a classic scan with %s shows the wrong-deck hint', async (_name, card) => {
    const { user } = renderScanner({ gameMode: 'classic' })

    await scanCardsInto(user, [number('5'), card])

    expect(screen.getByText(WRONG_DECK)).toBeInTheDocument()
  })

  it('a classic scan of classic cards shows no hint', async () => {
    const { user } = renderScanner({ gameMode: 'classic' })

    await scanCardsInto(user, [number('12'), { type: 'multiplier', value: 'x2' }])

    expect(screen.queryByText(WRONG_DECK)).not.toBeInTheDocument()
  })

  it('a Brutal scan shows no hint, as it is the same deck', async () => {
    const { user } = renderScanner({ gameMode: 'brutal' })

    await scanCardsInto(user, [number('13'), { type: 'divisor', value: '÷2' }])

    expect(screen.queryByText(WRONG_DECK)).not.toBeInTheDocument()
  })

  it('a Vengeance scan shows no hint', async () => {
    const { user } = renderScanner({ gameMode: 'vengeance' })

    await scanCardsInto(user, [number('13'), { type: 'divisor', value: '÷2' }])

    expect(screen.queryByText(WRONG_DECK)).not.toBeInTheDocument()
  })

  it('a restored draft shows no hint, as it was no scan', () => {
    renderScanner({ gameMode: 'classic', initialCards: [number('13')] })

    expect(screen.queryByText(WRONG_DECK)).not.toBeInTheDocument()
  })

  it('the hint goes once the host switches to Vengeance', async () => {
    const { user, rerenderWith } = renderScanner({ gameMode: 'classic' })
    await scanCardsInto(user, [number('13')])
    expect(screen.getByText(WRONG_DECK)).toBeInTheDocument()

    rerenderWith({ gameMode: 'vengeance' })

    expect(screen.queryByText(WRONG_DECK)).not.toBeInTheDocument()
  })

  it('a host moving the room back to Classic with a 13 on the table brings the hint up, as it follows the room', async () => {
    const { user, rerenderWith } = renderScanner({ gameMode: 'vengeance' })
    await scanCardsInto(user, [number('13')])
    expect(screen.queryByText(WRONG_DECK)).not.toBeInTheDocument()

    rerenderWith({ gameMode: 'classic' })

    expect(screen.getByText(WRONG_DECK)).toBeInTheDocument()
  })

  it('Retake clears the hint', async () => {
    const { user } = renderScanner({ gameMode: 'classic' })
    await scanCardsInto(user, [number('13')])

    await user.click(screen.getByRole('button', { name: /retake photo/i }))

    expect(screen.queryByText(WRONG_DECK)).not.toBeInTheDocument()
  })

  it('scanned special cards and modifiers score under Vengeance', async () => {
    const { user, onCardsConfirmed } = renderScanner({ gameMode: 'vengeance' })

    await scanCardsInto(user, [
      { type: 'special', value: '13' },
      number('13'),
      { type: 'divisor', value: '÷2' },
      { type: 'subtractor', value: '-4' },
    ])
    await user.click(confirmButton())

    expect(onCardsConfirmed).toHaveBeenCalledWith(expect.objectContaining({
      cards: [
        { type: 'special', value: '13' },
        { type: 'number', value: '13' },
        { type: 'divisor', value: '2' },
        { type: 'subtractor', value: '4' },
      ],
      finalScore: 9,
      isDuplicateBust: false,
    }))
  })

  it('a Lucky 13 scanned as a plain 13 can be fixed in one tap', async () => {
    const { user, onCardsConfirmed } = renderScanner({ gameMode: 'vengeance' })

    await scanCardsInto(user, [number('13'), number('13')])
    await user.click(screen.getByRole('button', { name: 'Change one 13 to Lucky 13' }))
    await user.click(confirmButton())

    expect(onCardsConfirmed).toHaveBeenCalledWith(expect.objectContaining({
      finalScore: 26,
      isDuplicateBust: false,
    }))
    const [{ cards }] = onCardsConfirmed.mock.calls[0]
    expect(cards.filter((card) => card.type === 'special')).toEqual([{ type: 'special', value: '13' }])
  })

  it('an Unlucky 7 scanned as a plain 7 can be corrected in one tap', async () => {
    const { user, onCardsConfirmed } = renderScanner({ gameMode: 'vengeance' })

    await scanCardsInto(user, [number('7'), number('7')])
    await user.click(screen.getByRole('button', { name: 'Change one 7 to Unlucky 7' }))
    await user.click(confirmButton())

    const [{ cards }] = onCardsConfirmed.mock.calls[0]
    expect(cards.filter((card) => card.type === 'special')).toEqual([{ type: 'special', value: '7' }])
  })
})

// The camera can suspend the page and kill the realtime socket (X26), so the room is told
// "scanning" through onScanStart before the file picker opens.
describe('CardScanner: entering-cards signal', () => {
  it.each([
    ['Tap to capture cards', /tap to capture cards/i],
    ['Choose from photos', /choose from photos/i],
  ])('%s calls onScanStart before it opens the picker', async (_label, buttonName) => {
    const clickPicker = vi.spyOn(HTMLInputElement.prototype, 'click')
    const onScanStart = vi.fn()
    const { user } = renderScanner({ onScanStart })

    await user.click(screen.getByRole('button', { name: buttonName }))

    expect(onScanStart).toHaveBeenCalledTimes(1)
    expect(clickPicker).toHaveBeenCalledTimes(1)
    expect(onScanStart.mock.invocationCallOrder[0]).toBeLessThan(clickPicker.mock.invocationCallOrder[0])
  })

  it('does not call onScanStart just by showing the capture screen', () => {
    const onScanStart = vi.fn()
    renderScanner({ onScanStart })

    expect(onScanStart).not.toHaveBeenCalled()
  })

  it('still opens the picker when no onScanStart is given', async () => {
    const clickPicker = vi.spyOn(HTMLInputElement.prototype, 'click')
    const { user } = renderScanner()

    await user.click(screen.getByRole('button', { name: /tap to capture cards/i }))

    expect(clickPicker).toHaveBeenCalledTimes(1)
  })
})
