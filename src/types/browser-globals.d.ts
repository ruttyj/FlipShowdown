// Browser APIs the app feature-detects that TypeScript's DOM lib doesn't declare.
// Each is optional because only some browsers have it.

interface Window {
    /** Safari < 14.1 only has the prefixed constructor. */
    webkitAudioContext?: typeof AudioContext;
}

interface Document {
    /** Chrome's Page Lifecycle API: true when the tab was discarded and is now reloading. */
    wasDiscarded?: boolean;
    /** Safari < 16.4 only has the prefixed Fullscreen API. */
    webkitFullscreenElement?: Element | null;
    webkitExitFullscreen?: () => Promise<void>;
}

interface HTMLElement {
    /** Safari < 16.4 only has the prefixed Fullscreen API. */
    webkitRequestFullscreen?: () => Promise<void>;
}

interface Navigator {
    /** Network Information API (Chrome on Android); fires `change` on a network switch. */
    connection?: EventTarget;
}
