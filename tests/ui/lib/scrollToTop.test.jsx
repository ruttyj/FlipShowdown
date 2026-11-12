import { afterEach, describe, expect, it, vi } from 'vitest'
import { scrollToTop } from '@/lib/scrollToTop'

// jsdom has no layout, so each test places the elements by stubbing getBoundingClientRect.
function place(element, top) {
  element.getBoundingClientRect = () => ({ top, bottom: top, left: 0, right: 0, width: 0, height: 0 })
}

// A scrolling container (like Layout's overflow-y-auto div), scrolled 500px down, with the
// element nested inside it.
function buildPage({ containerTop = 0, elementTop = 300, scrollTop = 500 } = {}) {
  const container = document.createElement('div')
  container.style.overflowY = 'auto'
  const wrapper = document.createElement('div')
  const element = document.createElement('section')
  wrapper.append(element)
  container.append(wrapper)
  document.body.append(container)

  container.scrollTop = scrollTop
  container.scrollTo = vi.fn()
  place(container, containerTop)
  place(element, elementTop)
  return { container, wrapper, element }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('scrollToTop', () => {
  it('scrolls the nearest scrolling ancestor so the element sits at its top', () => {
    const { container, element } = buildPage()

    scrollToTop(element)

    expect(container.scrollTo).toHaveBeenCalledWith({ top: 800, behavior: 'smooth' })
  })

  it("leaves the element's scroll-margin-top as a gap above it", () => {
    const { container, element } = buildPage()
    element.style.scrollMarginTop = '16px'

    scrollToTop(element)

    expect(container.scrollTo).toHaveBeenCalledWith({ top: 784, behavior: 'smooth' })
  })

  it("adds the container's scroll-padding-top too", () => {
    const { container, element } = buildPage()
    element.style.scrollMarginTop = '16px'
    container.style.scrollPaddingTop = '10px'

    scrollToTop(element)

    expect(container.scrollTo).toHaveBeenCalledWith({ top: 774, behavior: 'smooth' })
  })

  it('measures from the top of the container, not the window', () => {
    const { container, element } = buildPage({ containerTop: 50 })

    scrollToTop(element)

    expect(container.scrollTo).toHaveBeenCalledWith({ top: 750, behavior: 'smooth' })
  })

  it('aims for where the element comes to rest while it is still sliding in', () => {
    // A framer-motion entry animation that starts 20px low; scrollIntoView would measure it
    // there and leave it 20px too high once the slide finishes.
    const { container, wrapper, element } = buildPage({ elementTop: 320 })
    wrapper.style.transform = 'matrix(1, 0, 0, 1, 0, 20)'
    element.style.scrollMarginTop = '16px'

    scrollToTop(element)

    expect(container.scrollTo).toHaveBeenCalledWith({ top: 784, behavior: 'smooth' })
  })

  it('reads the offset from a 3D transform as well', () => {
    const { container, wrapper, element } = buildPage({ elementTop: 320 })
    wrapper.style.transform = 'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 20, 0, 1)'

    scrollToTop(element)

    expect(container.scrollTo).toHaveBeenCalledWith({ top: 800, behavior: 'smooth' })
  })

  it('scrolls the page when no ancestor scrolls, measuring from the top of the window', () => {
    const element = document.createElement('section')
    document.body.append(element)
    place(element, 300)
    const page = document.scrollingElement ?? document.documentElement
    page.scrollTo = vi.fn()

    scrollToTop(element)

    expect(page.scrollTo).toHaveBeenCalledWith({ top: 300, behavior: 'smooth' })
  })

  it('ignores a transform that is not a matrix', () => {
    const { container, wrapper, element } = buildPage()
    wrapper.style.transform = 'none'
    element.style.transform = 'rotate(0deg)'

    scrollToTop(element)

    expect(container.scrollTo).toHaveBeenCalledWith({ top: 800, behavior: 'smooth' })
  })

  it('does nothing without an element', () => {
    expect(() => scrollToTop(null)).not.toThrow()
  })
})
