// Small fetch wrapper for the self-hosted JSON API.
//
// Every request sends the session cookie (same-origin) and parses JSON responses.
// Non-2xx responses reject with an Error carrying `status` (HTTP status) and
// `data` (parsed body, or the raw text if it wasn't JSON).
//
// Requests use `redirect: 'manual'`: a 401, or an opaque redirect (Cloudflare Access bouncing
// an expired session to its login page), rejects with `Error{status: 401}` and notifies the
// `onSignedOut` listeners. GETs retry network errors and 5xx; other methods never retry.

// --- Helpers ---------------------------------------------------------------

/**
 * Appends query parameters to a path, skipping null/undefined values.
 * Example: buildUrl('/api/x', { sort: '-created_date', limit: undefined }) -> '/api/x?sort=-created_date'
 */
function buildUrl(path, query) {
    if (!query) {
        return path;
    }

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) {
            continue;
        }
        params.append(key, String(value));
    }

    const queryString = params.toString();
    if (queryString === '') {
        return path;
    }
    return `${path}?${queryString}`;
}

/** Parses a response body as JSON, falling back to the raw text (or null when empty). */
async function readBody(response) {
    const text = await response.text();
    if (text === '') {
        return null;
    }

    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/** Like readBody, but an unreadable body (connection dropped mid-read) gives null. */
async function readBodyOrNull(response) {
    try {
        return await readBody(response);
    } catch {
        return null;
    }
}

/** @typedef {Error & { status?: number, data?: unknown }} HttpError */

function createHttpError(response, data) {
    let message = `Request failed with status ${response.status}`;
    if (data && typeof data.message === 'string') {
        message = data.message;
    }

    /** @type {HttpError} */
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    return error;
}

// --- Retry and signed-out helpers ----------------------------------------------

const MAX_GET_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 300;

function defaultSleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createSignedOutError() {
    /** @type {HttpError} */
    const error = new Error('Signed out');
    error.status = 401;
    error.data = null;
    return error;
}

function isRetryableFailure(error) {
    // Errors made from a response carry a status; only 5xx among them is worth retrying.
    if (typeof error.status === 'number') {
        return error.status >= 500;
    }
    return true;
}

// --- Public API --------------------------------------------------------------

/**
 * Builds an HTTP client. `fetchImpl` and `sleep` are injectable for tests.
 *
 * @param {{ fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void> }} [options]
 */
export function createHttpClient({ fetchImpl, sleep = defaultSleep } = {}) {
    const signedOutListeners = new Set();

    function doFetch(url, init) {
        // The global is looked up per call so it can be replaced after this module loads.
        if (fetchImpl) {
            return fetchImpl(url, init);
        }
        return fetch(url, init);
    }

    function emitSignedOut() {
        for (const listener of [...signedOutListeners]) {
            try {
                listener();
            } catch (error) {
                console.error('[httpClient] signed-out listener failed:', error);
            }
        }
    }

    /** Registers a listener called when a request finds the session expired; returns unsubscribe(). */
    function onSignedOut(listener) {
        signedOutListeners.add(listener);
        return () => {
            signedOutListeners.delete(listener);
        };
    }

    async function attempt(url, init, signedOutEvent) {
        const response = await doFetch(url, init);

        if (response.type === 'opaqueredirect') {
            if (signedOutEvent) {
                emitSignedOut();
            }
            throw createSignedOutError();
        }

        // Announce the 401 before reading the body: an unreadable body must not hide it.
        if (response.status === 401) {
            if (signedOutEvent) {
                emitSignedOut();
            }
            throw createHttpError(response, await readBodyOrNull(response));
        }

        const data = await readBody(response);
        if (!response.ok) {
            throw createHttpError(response, data);
        }
        return data;
    }

    async function attemptWithRetries(url, init, maxRetries, signedOutEvent) {
        for (let retry = 0; ; retry += 1) {
            try {
                return await attempt(url, init, signedOutEvent);
            } catch (error) {
                const canRetry = retry < maxRetries && isRetryableFailure(error);
                if (!canRetry) {
                    throw error;
                }
                await sleep(RETRY_BASE_DELAY_MS * 2 ** retry);
            }
        }
    }

    /**
     * Sends a JSON request and resolves with the parsed response body.
     *
     * @param {string} method  HTTP method, e.g. 'GET'
     * @param {string} path    Same-origin path, e.g. '/api/entities/Player'
     * @param {{ body?: unknown, query?: Record<string, unknown>, signedOutEvent?: boolean }} [options]
     *        `signedOutEvent: false` rejects on a 401 without notifying the onSignedOut listeners,
     *        for probes where "not signed in" is an expected answer
     */
    function request(method, path, { body, query, signedOutEvent = true } = {}) {
        const init = {
            method,
            credentials: 'same-origin',
            redirect: 'manual',
            headers: { Accept: 'application/json' },
        };

        if (body !== undefined) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }

        const maxRetries = method.toUpperCase() === 'GET' ? MAX_GET_RETRIES : 0;
        return attemptWithRetries(buildUrl(path, query), init, maxRetries, signedOutEvent);
    }

    return { request, onSignedOut };
}

const defaultClient = createHttpClient();

export const request = defaultClient.request;
export const onSignedOut = defaultClient.onSignedOut;
