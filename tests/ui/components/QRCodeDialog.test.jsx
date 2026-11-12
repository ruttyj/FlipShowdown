// QRCodeDialog, QRCodeToggle and RoomCodeDisplay: the room code and the join URL.
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import QRCodeDialog from '@/components/game/QRCodeDialog'
import QRCodeToggle from '@/components/game/QRCodeToggle'
import RoomCodeDisplay from '@/components/game/RoomCodeDisplay'

const CODE = 'ABC234'
const JOIN_URL = `${window.location.origin}/room/${CODE}`

let writeText

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  vi.spyOn(toast, 'success').mockImplementation(() => 'toast')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('QRCodeDialog', () => {
  it('shows a QR image, the join URL and the room code when open', async () => {
    render(<QRCodeDialog open onOpenChange={() => {}} roomCode={CODE} />)

    expect(await screen.findByRole('img', { name: `QR code to join room ${CODE}` })).toBeInTheDocument()
    expect(screen.getByText(JOIN_URL)).toBeInTheDocument()
    expect(screen.getByText(CODE)).toBeInTheDocument()
  })

  it('renders nothing while closed', () => {
    render(<QRCodeDialog open={false} onOpenChange={() => {}} roomCode={CODE} />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('copies the join URL and the code', async () => {
    render(<QRCodeDialog open onOpenChange={() => {}} roomCode={CODE} />)

    fireEvent.click(screen.getByText(JOIN_URL))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(JOIN_URL))
    fireEvent.click(screen.getByText(CODE))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CODE))

    expect(toast.success).toHaveBeenCalledWith('Copied to clipboard!')
  })
})

describe('QRCodeToggle', () => {
  it('opens the dialog for the room', async () => {
    render(<QRCodeToggle roomCode={CODE} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    expect(screen.getByRole('button', { name: 'Show QR Code' })).toHaveAttribute('aria-label', 'Show QR Code')
    fireEvent.click(screen.getByRole('button', { name: 'Show QR Code' }))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(JOIN_URL)).toBeInTheDocument()
  })
})

describe('RoomCodeDisplay', () => {
  it('takes its background from the theme, not a fixed colour', () => {
    render(<RoomCodeDisplay roomCode={CODE} />)

    const card = screen.getByText('Room Code').parentElement
    expect(card).toHaveClass('room-code-card')
    expect(card.style.background).toBe('')
  })

  it('shows the code, copies the code and the link', async () => {
    render(<RoomCodeDisplay roomCode={CODE} />)

    expect(screen.getByText(CODE)).toBeInTheDocument()
    expect(await screen.findByRole('img', { name: `QR code to join room ${CODE}` })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Copy room code' }))
    expect(writeText).toHaveBeenLastCalledWith(CODE)

    fireEvent.click(screen.getByRole('button', { name: 'Copy join link' }))
    expect(writeText).toHaveBeenLastCalledWith(JOIN_URL)
  })

  it('shares the join link when the browser can share', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
    try {
      render(<RoomCodeDisplay roomCode={CODE} />)

      fireEvent.click(screen.getByRole('button', { name: 'Share join link' }))

      await waitFor(() => expect(share).toHaveBeenCalled())
      expect(share.mock.calls[0][0].url).toBe(JOIN_URL)
      // The invite names our app, not the publisher's game (X73).
      expect(share.mock.calls[0][0].title).toBe('Join my Flip Showdown room')
      expect(share.mock.calls[0][0].text).toBe(`Join my game on Flip Showdown! Room code: ${CODE}`)
    } finally {
      delete navigator.share
    }
  })

  it('copies the link when sharing is unsupported', () => {
    render(<RoomCodeDisplay roomCode={CODE} />)

    fireEvent.click(screen.getByRole('button', { name: 'Share join link' }))

    expect(writeText).toHaveBeenCalledWith(JOIN_URL)
  })

  it('has no QR button, since the code is already shown', () => {
    render(<RoomCodeDisplay roomCode={CODE} />)

    expect(screen.queryByRole('button', { name: /QR/ })).not.toBeInTheDocument()
  })

  it('gives the icon buttons a tooltip and renders children under them', () => {
    render(<RoomCodeDisplay roomCode={CODE}><button>Start</button></RoomCodeDisplay>)

    expect(screen.getByRole('button', { name: 'Copy room code' })).toHaveAttribute('title', 'Copy room code')
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument()
  })
})
