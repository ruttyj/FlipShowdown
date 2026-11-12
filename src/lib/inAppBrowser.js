// Chat and social apps open links in their own built-in browser, which has its own cookies.
// A player who scans the room QR code there has to sign in again and can easily become a
// second player (bug-review 7.9), so the join screen suggests opening the real browser.

// User-agent tokens of common in-app browsers. "; wv)" is Android's generic WebView.
const IN_APP_TOKENS = [
    'FBAN',
    'FBAV',
    'FB_IAB',
    'Instagram',
    'Line/',
    'MicroMessenger',
    'Snapchat',
    'Twitter',
    'LinkedInApp',
    'musical_ly',
    'BytedanceWebview',
    'GSA/',
    '; wv)',
];

/** @returns {boolean} true when the user agent looks like an app's built-in browser */
export function isInAppBrowser(userAgent) {
    if (!userAgent) {
        return false;
    }
    return IN_APP_TOKENS.some((token) => userAgent.includes(token));
}
