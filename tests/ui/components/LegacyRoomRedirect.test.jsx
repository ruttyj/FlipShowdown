// Old /GameRoom?code=X links (shared links, printed QR codes) still reach the room at /room/X.
import { render } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { expect, test } from 'vitest'
import LegacyRoomRedirect from '@/pages/LegacyRoomRedirect'

let currentLocation = null

function LocationProbe() {
  const location = useLocation()
  currentLocation = `${location.pathname}${location.search}`
  return null
}

function renderAt(url) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/GameRoom" element={<LegacyRoomRedirect />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

test('an old room link redirects to the room path', () => {
  renderAt('/GameRoom?code=3Z7R7L')

  expect(currentLocation).toBe('/room/3Z7R7L')
})

test('an old room link without a code goes home', () => {
  renderAt('/GameRoom')

  expect(currentLocation).toBe('/')
})
