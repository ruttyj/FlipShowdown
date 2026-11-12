// Fixed button stacks sit over the bottom of every game screen: the toggles on the right
// (Layout.jsx) and, during a game, the quick sends above the chat button on the left
// (QuickSendBar.jsx, ChatButton.jsx). A page needs room below its last content to scroll it
// clear of them. The numbers mirror those components' Tailwind classes; keep them in step.

// Gap left between the top of a stack and the content scrolled clear of it.
const BREATHING_ROOM_PX = 16;

// Right stack: bottom-4 (16px), up to four 40px toggles with gap-2 (8px).
const RIGHT_STACK_TOP_PX = 16 + 4 * 40 + 3 * 8;

// Left stack: the 56px chat button at bottom-6 (24px), and the quick sends from bottom-24 (96px)
// upwards, 48px each with gap-3 (12px). Each quick send's recipient badge pokes 6px above it.
const CHAT_BUTTON_TOP_PX = 24 + 56;
const QUICK_SENDS_BOTTOM_PX = 96;
const QUICK_SEND_SIZE_PX = 48;
const QUICK_SEND_GAP_PX = 12;
const QUICK_SEND_BADGE_PX = 6;

// How the left stack leaves and returns when chat is muted (X44): 24px inset + 56px chat button,
// plus some spare so the shadow and the quick send badges clear the edge as well.
export const LEFT_STACK_OFF_SCREEN = { x: -100, opacity: 0 };
export const LEFT_STACK_ON_SCREEN = { x: 0, opacity: 1 };

/**
 * @param {number} quickSendCount  quick sends shown on the left; 0 when the left stack is absent
 * @returns {number} px above the bottom edge (before the safe-area inset) that the tallest stack reaches
 */
export function floatingStacksTop(quickSendCount) {
    let leftTop = 0;
    if (quickSendCount > 0) {
        const quickSendsHeight = quickSendCount * QUICK_SEND_SIZE_PX + (quickSendCount - 1) * QUICK_SEND_GAP_PX;
        leftTop = QUICK_SENDS_BOTTOM_PX + quickSendsHeight + QUICK_SEND_BADGE_PX;
    }

    return Math.max(RIGHT_STACK_TOP_PX, CHAT_BUTTON_TOP_PX, leftTop);
}

/**
 * Inline style for a screen's root element so its last content can scroll above the stacks.
 *
 * @param {number} [quickSendCount]
 * @returns {{paddingBottom: string}}
 */
export function floatingStacksClearance(quickSendCount = 0) {
    const clearancePx = floatingStacksTop(quickSendCount) + BREATHING_ROOM_PX;
    return { paddingBottom: `calc(${clearancePx}px + env(safe-area-inset-bottom))` };
}
