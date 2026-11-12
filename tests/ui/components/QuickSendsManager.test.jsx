// QuickSendsManager. Drag reordering goes through the hook's
// reorderQuickSend, covered in QuickSendBar.test.jsx; jsdom cannot drag.
import React from 'react'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import QuickSendsManager from '@/components/game/QuickSendsManager'
import { makePlayer } from '../fixtures/renderGameHook.jsx'

// jsdom cannot drag, so capture the DragDropContext's onDragEnd and call it directly.
const dnd = vi.hoisted(() => ({ onDragEnd: null }))
vi.mock('@hello-pangea/dnd', async (importOriginal) => {
  const actual = await importOriginal()
  const DragDropContext = ({ onDragEnd, children }) => {
    dnd.onDragEnd = onDragEnd
    return <actual.DragDropContext onDragEnd={onDragEnd}>{children}</actual.DragDropContext>
  }
  return { ...actual, DragDropContext }
})

const PLAYERS = [makePlayer('p2', { name: 'Bo' }), makePlayer('p3', { name: 'Cy' })]
const COMBOS = [
  { emoji: '🎉', message: 'Yay', recipients: ['p2'] },
  { emoji: '🔥', message: '', recipients: ['p2', 'p3'] },
]

function renderManager(quickSends = COMBOS) {
  const props = { quickSends, otherPlayers: PLAYERS, onBack: vi.fn(), onDelete: vi.fn(), onUpdate: vi.fn(), onReorder: vi.fn() }
  render(<QuickSendsManager {...props} />)
  return props
}

describe('QuickSendsManager', () => {
  it('lists each combo with its message and recipients', () => {
    renderManager()

    expect(screen.getByText('2/4 saved')).toBeInTheDocument()
    expect(screen.getByText('Yay')).toBeInTheDocument()
    expect(screen.getByText('→ Bo')).toBeInTheDocument()
    expect(screen.getByText('→ Bo, Cy')).toBeInTheDocument()
  })

  it('shows an empty state without combos', () => {
    renderManager([])

    expect(screen.getByText('No quick sends saved yet.')).toBeInTheDocument()
  })

  it('delete reports the index', async () => {
    const props = renderManager()

    await userEvent.click(screen.getAllByRole('button', { name: 'Delete quick send' })[1])

    expect(props.onDelete).toHaveBeenCalledWith(1)
  })

  it('edits the message and recipients and saves them', async () => {
    const props = renderManager()

    await userEvent.click(screen.getAllByRole('button', { name: 'Edit quick send' })[0])
    await userEvent.clear(screen.getByPlaceholderText('Optional message...'))
    await userEvent.type(screen.getByPlaceholderText('Optional message...'), 'Woo')
    await userEvent.click(screen.getByRole('button', { name: 'Cy' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(props.onUpdate).toHaveBeenCalledWith(0, { emoji: '🎉', message: 'Woo', recipients: ['p2', 'p3'], toEveryone: false })
    expect(screen.queryByPlaceholderText('Optional message...')).not.toBeInTheDocument()
  })

  it('a default combo reads Everyone and edits from everyone selected', async () => {
    const props = renderManager([{ emoji: '❤️', message: '', recipients: [], toEveryone: true }])

    expect(screen.getByText('→ Everyone')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Edit quick send' }))
    await userEvent.click(screen.getByRole('button', { name: 'Bo' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(props.onUpdate).toHaveBeenCalledWith(0, { emoji: '❤️', message: '', recipients: ['p3'], toEveryone: false })
  })

  it('cancel leaves the combo unchanged', async () => {
    const props = renderManager()

    await userEvent.click(screen.getAllByRole('button', { name: 'Edit quick send' })[0])
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(props.onUpdate).not.toHaveBeenCalled()
    expect(screen.getByText('Yay')).toBeInTheDocument()
  })

  it('gives every row a labelled drag handle, in view and edit mode', async () => {
    renderManager()

    expect(screen.getByRole('button', { name: 'Reorder Yay' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reorder 🔥' })).toBeInTheDocument()

    await userEvent.click(screen.getAllByRole('button', { name: 'Edit quick send' })[0])

    expect(screen.getByRole('button', { name: 'Reorder Yay' })).toBeInTheDocument()
  })

  it('logs no console error when rendering edit mode', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      renderManager()

      await userEvent.click(screen.getAllByRole('button', { name: 'Edit quick send' })[0])

      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('saving an edit after a reorder updates the edited combo and leaves the others alone (X23)', async () => {
    const combos = [
      { emoji: 'A', message: 'a', recipients: ['p2'] },
      { emoji: 'B', message: 'b', recipients: ['p2'] },
      { emoji: 'C', message: 'c', recipients: ['p2'] },
    ]
    const props = renderManager(combos)

    await userEvent.click(screen.getAllByRole('button', { name: 'Edit quick send' })[0])
    await userEvent.clear(screen.getByPlaceholderText('Optional message...'))
    await userEvent.type(screen.getByPlaceholderText('Optional message...'), 'edited')
    act(() => {
      dnd.onDragEnd({ source: { index: 0 }, destination: { index: 2 } })
    })
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    // A was dragged from index 0 to index 2, so its edit belongs at index 2 and B (now 0) is untouched.
    expect(props.onReorder).toHaveBeenCalledWith(0, 2)
    expect(props.onUpdate).toHaveBeenCalledTimes(1)
    expect(props.onUpdate).toHaveBeenCalledWith(2, { emoji: 'A', message: 'edited', recipients: ['p2'], toEveryone: false })
  })

  it('Back calls onBack', async () => {
    const props = renderManager()

    await userEvent.click(screen.getByRole('button', { name: 'Back' }))

    expect(props.onBack).toHaveBeenCalled()
  })
})
