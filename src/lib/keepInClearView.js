// Keeps a button reachable as the list above it grows. The sticky Confirm bar and the phone keyboard
// both cover the bottom of the scrolling area, so the browser's own scrollIntoView stops too low.

import { findScrollContainer, scrollToTop } from './scrollToTop.js';

const GAP_PX = 12;
// The keyboard has finished opening well within this, so there is no more to follow after it.
const SETTLE_MS = 600;
const FIRST_SCROLL_DELAY_MS = 150;

/** Where the part of the screen nothing covers ends, in the same coordinates as a client rect. */
function clearBottom(element) {
    const viewport = window.visualViewport;
    const viewportBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;

    const footer = element.closest('section')?.querySelector('[data-sticky-footer]');
    if (footer) {
        return Math.min(viewportBottom, footer.getBoundingClientRect().top);
    }
    return viewportBottom;
}

function scrollAboveCover(element) {
    const overflow = element.getBoundingClientRect().bottom + GAP_PX - clearBottom(element);
    if (overflow > 0) {
        findScrollContainer(element).scrollTop += overflow;
    }
}

/** Calls scroll each time the keyboard opening shrinks the screen, until it has settled. */
function followKeyboard(scroll) {
    const viewport = window.visualViewport;
    const stop = () => {
        clearTimeout(timer);
        viewport?.removeEventListener('resize', scroll);
    };
    viewport?.addEventListener('resize', scroll);
    const timer = setTimeout(stop, SETTLE_MS);
    return stop;
}

/**
 * Scrolls just far enough to bring the element clear, and again as the keyboard opens and shrinks the
 * screen. Never scrolls up, so whatever was just focused above it stays on screen. The first scroll
 * waits a moment, so the new row is seen to appear before the list moves (X57).
 *
 * @param {HTMLElement|null} element
 * @returns {() => void} stops following the keyboard, and cancels a scroll still waiting
 */
export function keepInClearView(element) {
    if (!element) {
        return () => {};
    }

    const scroll = () => scrollAboveCover(element);
    const firstScroll = setTimeout(scroll, FIRST_SCROLL_DELAY_MS);
    const stopFollowing = followKeyboard(scroll);
    return () => {
        clearTimeout(firstScroll);
        stopFollowing();
    };
}

/**
 * Brings the element to the top of its container, and again as the keyboard opens: its arrival
 * interrupts a smooth scroll and leaves the element part way there (X56).
 *
 * @param {HTMLElement|null} element
 * @returns {() => void} stops following the keyboard
 */
export function keepAtTop(element) {
    const scroll = () => scrollToTop(element);
    scroll();
    return followKeyboard(scroll);
}
