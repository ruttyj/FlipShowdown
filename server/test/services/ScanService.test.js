import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { Clock } from '../../src/domain/clock.js';
import { MAX_IMAGE_BYTES, ScanOutcome, ScanService } from '../../src/services/ai/ScanService.js';

// ScanService over a fake Gemini fetch and a fake clock. ai.test.js covers it through the HTTP
// API, including the prompts and the model catalog.

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const SMALL_JPEG = 'data:image/jpeg;base64,aGVsbG8hISE=';
const MODEL_LIST = [
    { name: 'models/gemini-3.5-flash-lite', displayName: 'Flash-Lite', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.6-flash', displayName: 'Flash', supportedGenerationMethods: ['generateContent'] },
];

function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function answerWith(json) {
    return jsonResponse(200, {
        candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(json) }] }, finishReason: 'STOP' }],
    });
}

describe('ScanService', () => {
    let time;
    let warnings;
    let generate;

    /** A service with a Gemini key whose scans `generate()` answers. */
    function createService(apiKey = 'key') {
        return new ScanService({
            apiKey,
            defaultModel: DEFAULT_MODEL,
            logger: { warn: (message) => warnings.push(message) },
            fetchImpl: async (url) => {
                if (String(url).includes(':generateContent')) {
                    return generate();
                }
                return jsonResponse(200, { models: MODEL_LIST });
            },
            clock: new Clock(() => time),
        });
    }

    beforeEach(() => {
        time = 1_000_000;
        warnings = [];
        generate = () => answerWith({ cards: [] });
    });

    test('without a key it is disabled and offers no models', async () => {
        const scans = createService('');

        assert.equal(scans.isEnabled(), false);
        assert.deepEqual(await scans.getConfig(), { enabled: false, default_model: null, models: [] });
    });

    test('a scan while disabled throws rather than reaching for a missing client', async () => {
        await assert.rejects(createService('').scan({ image: SMALL_JPEG }), /scanning is disabled/);
    });

    test('with a key it offers the catalog models', async () => {
        const scans = createService();

        const config = await scans.getConfig();

        assert.equal(scans.isEnabled(), true);
        assert.equal(config.enabled, true);
        assert.equal(config.default_model, DEFAULT_MODEL);
        assert.ok(config.models.some((model) => model.id === DEFAULT_MODEL));
    });

    test('a scan reads the cards with the default model when none is asked for', async () => {
        const result = await createService().scan({ image: SMALL_JPEG });

        assert.deepEqual(result, { outcome: ScanOutcome.SCANNED, cards: [], model: DEFAULT_MODEL });
    });

    test('a scan uses an offered model it is asked for', async () => {
        const result = await createService().scan({ image: SMALL_JPEG, model: 'gemini-3.6-flash' });

        assert.equal(result.model, 'gemini-3.6-flash');
    });

    test('a bad image or an unknown model is an invalid request', async () => {
        const scans = createService();
        const tooLarge = `data:image/png;base64,${'A'.repeat(Math.ceil((MAX_IMAGE_BYTES + 3) / 3) * 4)}`;
        const cases = [
            [{ image: 5 }, 'image must be a data URL string'],
            [{ image: 'data:image/gif;base64,AAAA' }, 'image must be a base64 data URL of a JPEG, PNG or WebP image'],
            [{ image: 'data:image/png;base64,AAA' }, 'image must be a base64 data URL of a JPEG, PNG or WebP image'],
            [{ image: tooLarge }, 'image is too large (max 4 MB)'],
            [{ image: SMALL_JPEG, model: 'gpt-9' }, 'Unknown model'],
        ];
        for (const [request, message] of cases) {
            assert.deepEqual(await scans.scan(request), { outcome: ScanOutcome.INVALID_REQUEST, message });
        }
    });

    test('a Gemini failure is logged and mapped to what the client sees', async () => {
        const scans = createService();
        const cases = [
            [429, ScanOutcome.AI_BUSY, /busy right now/],
            [504, ScanOutcome.AI_FAILED, /took too long/],
            [500, ScanOutcome.AI_FAILED, /could not read this photo/],
        ];
        for (const [upstream, outcome, message] of cases) {
            generate = () => jsonResponse(upstream, { error: { message: 'nope' } });

            const result = await scans.scan({ image: SMALL_JPEG });

            assert.equal(result.outcome, outcome);
            assert.match(result.message, message);
        }
        assert.equal(warnings.length, 3);
        assert.match(warnings[0], /failed \(status 429\): nope/);
    });

    test('an answer in the wrong shape is a logged AI failure', async () => {
        generate = () => answerWith({ unexpected: true });

        const result = await createService().scan({ image: SMALL_JPEG });

        assert.equal(result.outcome, ScanOutcome.AI_FAILED);
        assert.match(result.message, /unreadable answer/);
        assert.match(warnings[0], /unexpected shape: \{"unexpected":true\}/);
    });

    test('a failure that is not Gemini\'s is thrown', async () => {
        // A response whose body can't be read: a TypeError, not a GeminiError.
        const brokenResponse = {
            ok: true,
            async text() {
                throw new TypeError('stream broke');
            },
        };
        generate = () => brokenResponse;

        await assert.rejects(createService().scan({ image: SMALL_JPEG }), /stream broke/);
    });

    test('each user gets 20 scans a minute', () => {
        const scans = createService();

        for (let index = 0; index < 20; index += 1) {
            assert.equal(scans.tryStartScan('ann@example.com'), true);
        }
        assert.equal(scans.tryStartScan('ann@example.com'), false);
        assert.equal(scans.tryStartScan('bob@example.com'), true);

        time += 60 * 1000 + 1;
        assert.equal(scans.tryStartScan('ann@example.com'), true);
    });
});
