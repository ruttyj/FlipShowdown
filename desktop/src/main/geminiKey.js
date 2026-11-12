// Checks a Gemini API key against Google the same way `npm run share` does (scripts/share.mjs):
// list the models with the key and read the HTTP status.

export const GEMINI_KEY_PAGE = 'https://aistudio.google.com/apikey';
export const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Statuses Google answers with when it rejects the key itself. */
const REJECTED_KEY_STATUSES = new Set([400, 401, 403]);

// On a network that drops packets silently, fetch would otherwise wait minutes for headers.
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * @typedef {'valid' | 'invalid' | 'unknown'} GeminiKeyStatus
 * 'unknown' means Google couldn't be reached or answered with an unrelated error, so the key
 * may still work; the launcher saves it anyway, as `share` does.
 */

/**
 * @param {string} key
 * @param {object} [options]
 * @param {typeof globalThis.fetch} [options.fetch]  Injected in tests.
 * @param {number} [options.timeoutMs]  After this long without an answer the result is 'unknown'.
 * @returns {Promise<GeminiKeyStatus>}
 */
export async function checkGeminiKey(key, { fetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const trimmedKey = key.trim();
    if (trimmedKey === '') {
        return 'invalid';
    }

    try {
        const response = await fetch(GEMINI_MODELS_URL, {
            headers: { 'x-goog-api-key': trimmedKey },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.ok) {
            return 'valid';
        }
        if (REJECTED_KEY_STATUSES.has(response.status)) {
            return 'invalid';
        }
        return 'unknown';
    } catch {
        return 'unknown';
    }
}
