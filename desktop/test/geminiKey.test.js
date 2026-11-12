import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkGeminiKey, GEMINI_KEY_PAGE, GEMINI_MODELS_URL } from '../src/main/geminiKey.js';

/** A fetch stand-in that records its calls and answers with `status`. */
function fakeFetch(status) {
    const calls = [];
    const fetch = async (url, options) => {
        calls.push({ url, options });
        return new Response(null, { status });
    };
    return { fetch, calls };
}

// --- Asking Google ---

test('checkGeminiKey lists models with the key in the x-goog-api-key header', async () => {
    const { fetch, calls } = fakeFetch(200);

    await checkGeminiKey('my-key', { fetch });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, GEMINI_MODELS_URL);
    assert.equal(calls[0].options.headers['x-goog-api-key'], 'my-key');
});

test('checkGeminiKey sends the trimmed key', async () => {
    const { fetch, calls } = fakeFetch(200);

    await checkGeminiKey('  my-key \n', { fetch });

    assert.equal(calls[0].options.headers['x-goog-api-key'], 'my-key');
});

test('the endpoints match npm run share', () => {
    assert.equal(GEMINI_MODELS_URL, 'https://generativelanguage.googleapis.com/v1beta/models');
    assert.equal(GEMINI_KEY_PAGE, 'https://aistudio.google.com/apikey');
});

// --- Results ---

test('checkGeminiKey reports valid when Google accepts the key', async () => {
    const { fetch } = fakeFetch(200);

    assert.equal(await checkGeminiKey('k', { fetch }), 'valid');
});

test('checkGeminiKey reports invalid when Google rejects the key', async () => {
    for (const status of [400, 401, 403]) {
        const { fetch } = fakeFetch(status);

        assert.equal(await checkGeminiKey('k', { fetch }), 'invalid', String(status));
    }
});

test('checkGeminiKey reports unknown for other HTTP errors', async () => {
    for (const status of [404, 429, 500, 503]) {
        const { fetch } = fakeFetch(status);

        assert.equal(await checkGeminiKey('k', { fetch }), 'unknown', String(status));
    }
});

test('checkGeminiKey reports unknown when Google cannot be reached', async () => {
    const fetch = async () => {
        throw new TypeError('fetch failed');
    };

    assert.equal(await checkGeminiKey('k', { fetch }), 'unknown');
});

test('checkGeminiKey reports unknown when Google does not answer in time', async () => {
    // Never answers: only an abort signal can end the request. AbortSignal.timeout's timer does
    // not keep Node alive, so a pending request holds the event loop open the way a socket would.
    const fetch = (url, options) => new Promise((resolve, reject) => {
        const openSocket = setTimeout(() => {}, 5000);
        options.signal?.addEventListener('abort', () => {
            clearTimeout(openSocket);
            reject(options.signal.reason);
        });
    });

    assert.equal(await checkGeminiKey('k', { fetch, timeoutMs: 20 }), 'unknown');
});

test('checkGeminiKey reports invalid for a blank key without calling Google', async () => {
    const { fetch, calls } = fakeFetch(200);

    assert.equal(await checkGeminiKey('   ', { fetch }), 'invalid');
    assert.equal(calls.length, 0);
});
