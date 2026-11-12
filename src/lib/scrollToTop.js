// Brings an element to the top of its scrolling container, like
// scrollIntoView({ block: 'start' }) but measured from where the element will come to rest.
// scrollIntoView measures the element as it is right now, so one still sliding in (the
// framer-motion `y` entry offset on the game screen's panels) ended up that many pixels too
// high, its top cut off, once the slide finished.

function isScrollable(node) {
    const { overflowY } = getComputedStyle(node);
    return overflowY === 'auto' || overflowY === 'scroll';
}

// The game screens scroll inside Layout's overflow-y-auto div, not the window.
export function findScrollContainer(element) {
    for (let node = element.parentElement; node; node = node.parentElement) {
        if (isScrollable(node)) {
            return node;
        }
    }
    return document.scrollingElement ?? document.documentElement;
}

/** The vertical offset in a computed transform: matrix(a, b, c, d, e, f) or matrix3d(... 16 values). */
function translateYOf(transform) {
    let index;
    if (transform.startsWith('matrix3d(')) {
        index = 13;
    } else if (transform.startsWith('matrix(')) {
        index = 5;
    } else {
        return 0;
    }

    // parseFloat, not Number, so the last value's closing ")" is ignored.
    const values = transform.slice(transform.indexOf('(') + 1).split(',');
    return parseFloat(values[index]);
}

/** How far the element and its ancestors (up to the container) are shifted by transforms. */
function transformOffset(element, container) {
    let offset = 0;
    for (let node = element; node && node !== container; node = node.parentElement) {
        offset += translateYOf(getComputedStyle(node).transform);
    }
    return offset;
}

function pixels(value) {
    return parseFloat(value) || 0;
}

/**
 * Smooth-scrolls so the element's top lines up with the top of its scrolling container,
 * leaving the element's scroll-margin-top and the container's scroll-padding-top as a gap.
 */
export function scrollToTop(element) {
    if (!element) {
        return;
    }

    const container = findScrollContainer(element);
    const isPage = container === document.scrollingElement || container === document.documentElement;
    const containerTop = isPage ? 0 : container.getBoundingClientRect().top;
    const restingTop = element.getBoundingClientRect().top - transformOffset(element, container);
    const gap = pixels(getComputedStyle(element).scrollMarginTop) + pixels(getComputedStyle(container).scrollPaddingTop);

    container.scrollTo({
        top: container.scrollTop + restingTop - containerTop - gap,
        behavior: 'smooth',
    });
}
