// Where to send the browser after login, without becoming an open redirect.

/**
 * Returns a same-origin path to redirect to after login, or "/" when
 * `fromUrl` is missing or points elsewhere. Examples:
 *   "/room/abc?x=1"                       -> "/room/abc?x=1"
 *   "https://<this host>/room/abc"        -> "/room/abc"
 *   "//evil.com", "/\\evil.com", "https://evil.com/" -> "/"
 */
export function safeRedirectTarget(fromUrl, requestOrigin) {
    if (typeof fromUrl !== 'string' || fromUrl === '') {
        return '/';
    }

    // Control characters can make browsers parse the URL differently than we do.
    if (/[\u0000-\u001f\u007f]/.test(fromUrl)) {
        return '/';
    }

    // A single leading slash is a path; "//" or "/\" would be protocol-relative.
    const isLocalPath = fromUrl.startsWith('/') && fromUrl[1] !== '/' && fromUrl[1] !== '\\';
    if (isLocalPath) {
        return fromUrl;
    }

    let parsed;
    try {
        parsed = new URL(fromUrl);
    } catch {
        return '/';
    }
    if (parsed.origin !== requestOrigin) {
        return '/';
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
