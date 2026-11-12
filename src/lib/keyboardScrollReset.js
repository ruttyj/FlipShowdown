// The app scrolls inside Layout's own div, so the page itself should never move. But iOS scrolls the
// page to show a focused field above the keyboard, and can leave it there once the keyboard has
// closed, with blank space under the app until something forces a redraw (X50).

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function isEditing(activeElement) {
    if (!activeElement) {
        return false;
    }
    return EDITABLE_TAGS.has(activeElement.tagName) || Boolean(activeElement.isContentEditable);
}

/**
 * Puts the page back at the top whenever it has moved and no field needs it there.
 *
 * @param {Window} win
 * @returns {() => void} removes the listeners
 */
export function installKeyboardScrollReset(win) {
    let focusTimer = null;

    const resetScroll = () => {
        if (win.scrollY !== 0 && !isEditing(win.document.activeElement)) {
            win.scrollTo(0, 0);
        }
    };

    // Focus is on nothing yet when one field hands over to another, so look after it has landed.
    const handleFocusOut = () => {
        win.clearTimeout(focusTimer);
        focusTimer = win.setTimeout(resetScroll, 0);
    };

    win.document.addEventListener('focusout', handleFocusOut);
    win.addEventListener('scroll', resetScroll);
    // Resizes as the keyboard closes, which can be after focus has left. Older browsers don't have it.
    win.visualViewport?.addEventListener('resize', resetScroll);

    return () => {
        win.clearTimeout(focusTimer);
        win.document.removeEventListener('focusout', handleFocusOut);
        win.removeEventListener('scroll', resetScroll);
        win.visualViewport?.removeEventListener('resize', resetScroll);
    };
}
