import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GeminiError, createGeminiClient } from '../src/gemini.js';

// No real network: fetch is always injected.

const IMAGE = { mimeType: 'image/jpeg', base64: 'aGk=' };

function json(status, body) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function answer(text) {
    return json(200, { candidates: [{ content: { parts: [{ text }] } }] });
}

function clientWith(fetchImpl) {
    return createGeminiClient({ apiKey: 'key', fetchImpl });
}

async function rejectionOf(promise) {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    return assert.fail('expected a rejection');
}

function generate(fetchImpl, extra = {}) {
    return clientWith(fetchImpl).generateJson({ model: 'm', prompt: 'p', image: IMAGE, ...extra });
}

describe('Gemini transport errors', () => {
    test('a timeout becomes a 504 GeminiError', async () => {
        const timeout = Object.assign(new Error('slow'), { name: 'TimeoutError' });
        const error = await rejectionOf(generate(async () => {
            throw timeout;
        }));
        assert.ok(error instanceof GeminiError);
        assert.equal(error.status, 504);
    });

    test('a network failure becomes status 0 with the cause as detail', async () => {
        const error = await rejectionOf(generate(async () => {
            throw new TypeError('fetch failed');
        }));
        assert.equal(error.status, 0);
        assert.match(error.detail, /fetch failed/);
    });

    test('a rejection with no value still becomes a network failure', async () => {
        const error = await rejectionOf(generate(async () => {
            throw undefined;
        }));
        assert.equal(error.status, 0);
    });

    test('a non-JSON error body is used as text, truncated to 500 characters', async () => {
        const error = await rejectionOf(generate(async () => new Response('x'.repeat(900), { status: 502 })));
        assert.equal(error.status, 502);
        assert.equal(error.detail.length, 500);
    });

    test('a JSON error body without error.message falls back to the raw text', async () => {
        const bodies = [{ error: { code: 500 } }, { error: { message: 42 } }, { other: true }, null];
        for (const body of bodies) {
            const error = await rejectionOf(generate(async () => json(500, body)));
            assert.equal(error.status, 500);
            assert.equal(error.detail, JSON.stringify(body));
        }
    });

    test('error.message is used when present', async () => {
        const error = await rejectionOf(generate(async () => json(429, { error: { message: 'Resource exhausted' } })));
        assert.equal(error.detail, 'Resource exhausted');
    });

    test('a 200 with a non-JSON body is a GeminiError', async () => {
        const error = await rejectionOf(generate(async () => new Response('<html>', { status: 200 })));
        assert.match(error.message, /non-JSON/);
    });
});

describe('Gemini answers that are unusable', () => {
    test('no candidates, empty text and a missing content all fail with the finish reason', async () => {
        const cases = [
            [{ candidates: [] }, 'no candidates'],
            [{}, 'no candidates'],
            [{ candidates: [{ finishReason: 'SAFETY' }] }, 'SAFETY'],
            [{ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }] }, 'STOP'],
            [{ candidates: [{ content: { parts: [{ text: 'secret thought', thought: true }] }, finishReason: 'STOP' }] }, 'STOP'],
        ];
        for (const [body, reason] of cases) {
            const error = await rejectionOf(generate(async () => json(200, body)));
            assert.match(error.message, /no text/);
            assert.match(error.detail, new RegExp(reason));
        }
    });

    test('a safety block names the reason', async () => {
        const error = await rejectionOf(generate(async () => json(200, { promptFeedback: { blockReason: 'SAFETY' } })));
        assert.match(error.message, /blocked/);
        assert.match(error.detail, /SAFETY/);
    });

    test('text that is not JSON, or has broken braces, is malformed JSON', async () => {
        for (const text of ['no braces here', '} backwards {', 'prefix {not: json} suffix']) {
            const error = await rejectionOf(generate(async () => answer(text)));
            assert.match(error.message, /malformed JSON/);
        }
    });
});

describe('Gemini requests and answers', () => {
    test('thought parts are skipped and JSON inside prose is extracted', async () => {
        const body = { candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: 'Here:\n```json\n{"a":' }, { text: '1}\n```' }] } }] };
        const result = await generate(async () => json(200, body));
        assert.deepEqual(result, { a: 1 });
    });

    test('a schema adds structured output config; without one it is left out', async () => {
        const requests = [];
        const fetchImpl = async (url, init) => {
            requests.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
            return answer('{}');
        };
        await generate(fetchImpl, { schema: { type: 'object' } });
        await generate(fetchImpl);
        assert.deepEqual(requests[0].body.generationConfig.responseFormat.text.schema, { type: 'object' });
        assert.equal(requests[1].body.generationConfig, undefined);
        assert.equal(requests[0].headers['x-goog-api-key'], 'key');
        assert.ok(!requests[0].url.includes('key'));
    });

    test('listModels follows page tokens, tolerates a page without models and stops at 5 pages', async () => {
        const urls = [];
        const pages = [{ models: [{ name: 'a' }], nextPageToken: 't1' }, { nextPageToken: 't2' }, { models: [{ name: 'b' }] }];
        const result = await clientWith(async (url) => {
            urls.push(String(url));
            return json(200, pages[urls.length - 1]);
        }).listModels();
        assert.deepEqual(result.map((entry) => entry.name), ['a', 'b']);
        assert.ok(urls[1].includes('pageToken=t1'));
        assert.ok(!urls[0].includes('pageToken'));

        let calls = 0;
        await clientWith(async () => {
            calls += 1;
            return json(200, { models: [], nextPageToken: 'more' });
        }).listModels();
        assert.equal(calls, 5);
    });
});
