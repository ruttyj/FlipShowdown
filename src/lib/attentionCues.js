// Pure state for "something happened while you were away" cues.
// Cue state: { baseTitle, text, title } where title is what document.title should be,
// or null when no cue is active.

export const IDLE_CUE_STATE = { baseTitle: null, text: null, title: null };

export const VIBRATION_PATTERNS = {
    turn: [200, 100, 200],
    gameStart: [150, 80, 150, 80, 300],
    gameEnd: [400],
};

export function vibrationFor(kind) {
    return VIBRATION_PATTERNS[kind] || null;
}

// Prefixes the title only while the page is hidden. The original title is remembered
// from the first cue so repeated cues don't stack prefixes.
export function applyTitleCue(state, currentTitle, text, isHidden) {
    if (!isHidden) {
        return state;
    }
    const baseTitle = state.baseTitle === null ? currentTitle : state.baseTitle;
    return { baseTitle, text, title: `• ${text} — ${baseTitle}` };
}

// Returns the idle state; the caller restores the old `baseTitle` first when not null.
export function clearTitleCue() {
    return IDLE_CUE_STATE;
}
