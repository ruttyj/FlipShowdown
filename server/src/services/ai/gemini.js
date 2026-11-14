// Thin client for the Gemini REST API (generativelanguage.googleapis.com).
//
// The API key travels in the x-goog-api-key header, never in the URL, so it can't
// end up in access logs or error messages. `fetchImpl` is injectable for tests.

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// The list endpoint caps pages at 1000 models; a handful of pages is plenty.
const MODELS_PAGE_SIZE = 1000;
const MAX_MODEL_PAGES = 5;

const LIST_TIMEOUT_MS = 15_000;
// Vision calls on a thinking model can take a while; the phone shows a spinner meanwhile.
const GENERATE_TIMEOUT_MS = 90_000;

// Upstream status used when the request never got an HTTP response.
const NETWORK_FAILURE_STATUS = 0;
const TIMEOUT_STATUS = 504;

/**
 * A failed Gemini call. `status` is the upstream HTTP status (0 for network
 * failures, 504 for timeouts, 200 when the response itself was unusable) and
 * `detail` is the upstream explanation, meant for server logs only.
 */
export class GeminiError extends Error {
    constructor(message, status, detail) {
        super(message);
        this.name = 'GeminiError';
        this.status = status;
        this.detail = detail || message;
    }
}

// --- HTTP ----------------------------------------------------------------

/** Pulls `error.message` out of a Google error body, falling back to the raw text. */
function describeErrorBody(text) {
    try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.error && typeof parsed.error.message === 'string') {
            return parsed.error.message;
        }
    } catch {
        // Not JSON (e.g. an HTML error page from a proxy); use the text as-is.
    }
    return text.slice(0, 500);
}

async function sendRequest(context, url, init, timeoutMs) {
    const headers = { 'x-goog-api-key': context.apiKey, ...init.headers };

    let response;
    try {
        response = await context.fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
        if (error && error.name === 'TimeoutError') {
            throw new GeminiError('Gemini request timed out', TIMEOUT_STATUS);
        }
        throw new GeminiError('Could not reach Gemini', NETWORK_FAILURE_STATUS, String(error));
    }

    const text = await response.text();
    if (!response.ok) {
        throw new GeminiError(`Gemini responded with ${response.status}`, response.status, describeErrorBody(text));
    }

    try {
        return JSON.parse(text);
    } catch {
        throw new GeminiError('Gemini returned a non-JSON response', response.status, text.slice(0, 500));
    }
}

// --- Models --------------------------------------------------------------

async function listModels(context) {
    const models = [];
    let pageToken = null;

    for (let page = 0; page < MAX_MODEL_PAGES; page++) {
        const params = new URLSearchParams({ pageSize: String(MODELS_PAGE_SIZE) });
        if (pageToken) {
            params.set('pageToken', pageToken);
        }

        const body = await sendRequest(context, `${GEMINI_BASE_URL}/models?${params}`, { method: 'GET' }, LIST_TIMEOUT_MS);
        if (Array.isArray(body.models)) {
            models.push(...body.models);
        }

        pageToken = body.nextPageToken;
        if (!pageToken) {
            break;
        }
    }

    return models;
}

// --- Generation ----------------------------------------------------------

function buildGenerateBody({ prompt, image, schema }) {
    const body = {
        contents: [
            {
                role: 'user',
                // Google recommends the image before the text for single-image prompts.
                parts: [
                    { inlineData: { mimeType: image.mimeType, data: image.base64 } },
                    { text: prompt },
                ],
            },
        ],
    };

    // Without a schema (models lacking structured output) the prompt alone asks for JSON.
    if (schema) {
        body.generationConfig = {
            // Structured output: the model is constrained to JSON matching `schema`.
            // responseFormat replaces the deprecated responseMimeType + responseSchema pair.
            responseFormat: {
                text: { mimeType: 'APPLICATION_JSON', schema },
            },
        };
    }
    return body;
}

/**
 * Parses the model's answer as JSON. Answers produced without structured output
 * often wrap the JSON in prose or a markdown fence, so fall back to the outermost
 * {...} in the text. Example: 'Here you go:\n```json\n{"cards":[]}\n```' -> { cards: [] }.
 */
function parseJsonAnswer(text) {
    try {
        return JSON.parse(text);
    } catch {
        // Try the embedded object below.
    }

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) {
        throw new GeminiError('Gemini returned malformed JSON', 200, text.slice(0, 500));
    }

    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch {
        throw new GeminiError('Gemini returned malformed JSON', 200, text.slice(0, 500));
    }
}

/** Concatenates the answer text of the first candidate, skipping thought summaries. */
function extractCandidateText(body) {
    const blockReason = body.promptFeedback && body.promptFeedback.blockReason;
    if (blockReason) {
        throw new GeminiError('Gemini blocked the request', 200, `blockReason=${blockReason}`);
    }

    const candidate = Array.isArray(body.candidates) ? body.candidates[0] : null;
    const parts = candidate && candidate.content && Array.isArray(candidate.content.parts)
        ? candidate.content.parts
        : [];

    let text = '';
    for (const part of parts) {
        if (typeof part.text === 'string' && !part.thought) {
            text += part.text;
        }
    }

    if (text === '') {
        const finishReason = candidate ? candidate.finishReason : 'no candidates';
        throw new GeminiError('Gemini returned no text', 200, `finishReason=${finishReason}`);
    }
    return text;
}

async function generateJson(context, { model, prompt, image, schema }) {
    const url = `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`;
    const init = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildGenerateBody({ prompt, image, schema })),
    };

    const body = await sendRequest(context, url, init, GENERATE_TIMEOUT_MS);
    return parseJsonAnswer(extractCandidateText(body));
}

// --- Public API ----------------------------------------------------------

/**
 * Returns { listModels(), generateJson({ model, prompt, image, schema }) }.
 *   listModels()   -> raw Model resources from GET /v1beta/models (all pages)
 *   generateJson() -> the parsed JSON answer; image is { mimeType, base64 };
 *                     schema is optional (omit it for models without structured output)
 * Both reject with GeminiError.
 */
export function createGeminiClient({ apiKey, fetchImpl = globalThis.fetch }) {
    const context = { apiKey, fetchImpl };
    return {
        listModels: () => listModels(context),
        generateJson: (request) => generateJson(context, request),
    };
}
