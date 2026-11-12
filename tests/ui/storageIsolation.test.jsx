// Proves setup.js clears localStorage and sessionStorage after every test. The two tests
// depend on running in file order, which Vitest guarantees within one file.
import { describe, expect, it } from 'vitest'

describe('storage isolation between tests', () => {
  it('writes to both storages', () => {
    localStorage.setItem('leak-check', 'local')
    sessionStorage.setItem('leak-check', 'session')

    expect(localStorage.getItem('leak-check')).toBe('local')
  })

  it('starts with both storages empty', () => {
    expect(localStorage.getItem('leak-check')).toBeNull()
    expect(sessionStorage.getItem('leak-check')).toBeNull()
  })
})
