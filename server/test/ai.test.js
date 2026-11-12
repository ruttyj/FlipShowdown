import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { api, devLogin, startTestServer } from './helpers.js';

// No real network: every Gemini call goes to a fake fetch that records requests.

const API_KEY = 'test-gemini-key';
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
// A tiny but valid base64 payload ("hello!!!" -> 8 bytes).
const SMALL_JPEG = 'data:image/jpeg;base64,aGVsbG8hISE=';

// What the classic scan sends to Gemini, so nothing added for another mode
// can change it. Changing these means changing the classic prompt on
// purpose, which needs its own check against real photos.
const CLASSIC_PROMPT_SHA256 = '8d0e002d9694cfa15bf2e4883cc318efcbf62a8b8ec6f42e1ea9298e5c5f45d6';
const CLASSIC_SCHEMA_SHA256 = '3c3b909631f3e949d0b2ebb5bfef819e4e3625ed8146d148937acf359070c818';
const CLASSIC_GEMMA_PROMPT_SHA256 = 'cf8ae6328f5f78c85898ee3db501c4c6f0fd62f5149c586c07ec30bbd61ddeb1';

function sha256(text) {
    return createHash('sha256').update(text).digest('hex');
}

const MODEL_LIST = [
    { name: 'models/gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
    { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro Preview', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.8-flash-tts', displayName: 'TTS', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.8-live', displayName: 'Live', supportedGenerationMethods: ['bidiGenerateContent'] },
    { name: 'models/gemini-3.1-flash-image', displayName: 'Image', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-embedding-001', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemma-4-31b-it', displayName: 'Gemma 4 31B', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemma-4-26b-a4b-it', displayName: 'Gemma 4 26B A4B', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemma-3-27b-it', displayName: 'Gemma 3 27B', supportedGenerationMethods: ['generateContent'] },
    // Text-only Gemma models are left out.
    { name: 'models/gemma-3-1b-it', displayName: 'Gemma 3 1B', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemma-3n-e4b-it', displayName: 'Gemma 3n E4B', supportedGenerationMethods: ['generateContent'] },
];

// --- Fake Gemini ---------------------------------------------------------

function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function answerWith(json) {
    return jsonResponse(200, {
        candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(json) }] }, finishReason: 'STOP' }],
    });
}

/**
 * fetch replacement. `fake.listModels` and `fake.generate` decide the
 * responses; `fake.calls` records { url, init } for every request.
 */
function createFakeGemini() {
    const fake = {
        calls: [],
        listModels: () => jsonResponse(200, { models: MODEL_LIST }),
        generate: () => answerWith({ cards: [] }),
        fetch: async (url, init) => {
            fake.calls.push({ url: String(url), init });
            if (String(url).includes(':generateContent')) {
                return fake.generate(url, init);
            }
            return fake.listModels(url, init);
        },
        callsTo(fragment) {
            return fake.calls.filter((call) => call.url.includes(fragment));
        },
    };
    return fake;
}

// --- Disabled ------------------------------------------------------------

describe('AI routes without a Gemini key', () => {
    let server;
    let cookie;

    before(async () => {
        server = await startTestServer();
        cookie = await devLogin(server.baseUrl, 'alice@example.com');
    });

    after(async () => {
        await server.stop();
    });

    test('config reports AI as disabled', async () => {
        const response = await api(server.baseUrl, 'GET', '/api/ai/config', { cookie });
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, { enabled: false, default_model: null, models: [] });
    });

    test('scan answers 503', async () => {
        const response = await api(server.baseUrl, 'POST', '/api/ai/scan-cards', { cookie, body: { image: SMALL_JPEG } });
        assert.equal(response.status, 503);
        assert.equal(typeof response.body.message, 'string');
    });
});

// --- Enabled -------------------------------------------------------------

describe('AI routes with a Gemini key', () => {
    let server;
    let cookie;
    let fake;
    let clock;

    before(async () => {
        fake = createFakeGemini();
        clock = { time: 1_000_000 };
        server = await startTestServer({
            env: { GEMINI_API_KEY: API_KEY },
            geminiFetch: (url, init) => fake.fetch(url, init),
            now: () => clock.time,
        });
        cookie = await devLogin(server.baseUrl, 'alice@example.com');
    });

    after(async () => {
        await server.stop();
    });

    beforeEach(() => {
        // The server's geminiFetch reads `fake` on every call, so swapping it resets the stubs.
        fake = createFakeGemini();
        // Each test starts with an expired model cache and a fresh rate-limit window.
        clock.time += 2 * 60 * 60 * 1000;
    });

    function scan(body, userCookie = cookie) {
        return api(server.baseUrl, 'POST', '/api/ai/scan-cards', { cookie: userCookie, body });
    }

    test('routes require authentication', async () => {
        const config = await api(server.baseUrl, 'GET', '/api/ai/config');
        assert.equal(config.status, 401);

        const scanResponse = await api(server.baseUrl, 'POST', '/api/ai/scan-cards', { body: { image: SMALL_JPEG } });
        assert.equal(scanResponse.status, 401);
        assert.equal(fake.calls.length, 0);
    });

    test('config lists usable models: default first, newest Gemini Flash first, then vision Gemma', async () => {
        const response = await api(server.baseUrl, 'GET', '/api/ai/config', { cookie });
        assert.equal(response.status, 200);
        assert.equal(response.body.enabled, true);
        assert.equal(response.body.default_model, DEFAULT_MODEL);
        assert.deepEqual(response.body.models, [
            { id: 'gemini-3.5-flash-lite', display_name: 'Gemini 3.5 Flash-Lite' },
            { id: 'gemini-3.8-flash', display_name: 'Gemini 3.8 Flash' },
            { id: 'gemini-3.6-flash', display_name: 'Gemini 3.6 Flash' },
            { id: 'gemini-3.1-pro-preview', display_name: 'Gemini 3.1 Pro Preview' },
            { id: 'gemma-4-26b-a4b-it', display_name: 'Gemma 4 26B A4B' },
            { id: 'gemma-4-31b-it', display_name: 'Gemma 4 31B' },
            { id: 'gemma-3-27b-it', display_name: 'Gemma 3 27B' },
        ]);
    });

    test('Gemma gets the JSON format in the prompt, and fenced answers still parse', async () => {
        fake.generate = () => jsonResponse(200, {
            candidates: [{
                content: { role: 'model', parts: [{ text: 'Here are the cards:\n```json\n{"cards":[{"value":"9","type":"number"}]}\n```' }] },
                finishReason: 'STOP',
            }],
        });

        const response = await scan({ image: SMALL_JPEG, model: 'gemma-4-31b-it' });
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, { model: 'gemma-4-31b-it', cards: [{ value: '9', type: 'number' }] });

        const sent = JSON.parse(fake.callsTo(':generateContent')[0].init.body);
        assert.equal(sent.generationConfig, undefined);
        assert.match(sent.contents[0].parts[1].text, /Answer with only a JSON object/);
    });

    test('the model list call sends the key in a header, not the URL', async () => {
        await api(server.baseUrl, 'GET', '/api/ai/config', { cookie });
        const [call] = fake.callsTo('/v1beta/models');
        assert.equal(call.init.headers['x-goog-api-key'], API_KEY);
        assert.ok(!call.url.includes(API_KEY));
    });

    test('the model list is cached for an hour', async () => {
        await api(server.baseUrl, 'GET', '/api/ai/config', { cookie });
        await api(server.baseUrl, 'GET', '/api/ai/config', { cookie });
        assert.equal(fake.calls.length, 1);

        clock.time += 61 * 60 * 1000;
        await api(server.baseUrl, 'GET', '/api/ai/config', { cookie });
        assert.equal(fake.calls.length, 2);
    });

    test('a failed model list falls back to just the default model', async () => {
        fake.listModels = () => jsonResponse(500, { error: { message: 'boom' } });
        const response = await api(server.baseUrl, 'GET', '/api/ai/config', { cookie });
        assert.equal(response.status, 200);
        assert.deepEqual(response.body.models, [{ id: DEFAULT_MODEL, display_name: DEFAULT_MODEL }]);
    });

    test('scan sends the photo, prompt and schema to Gemini and returns normalised cards', async () => {
        fake.generate = () => answerWith({
            cards: [
                { value: '7', type: 'number' },
                { value: 'X2', type: 'multiplier' },
                { value: '+4', type: 'number' },
                { value: 12, type: 'number' },
                { value: 'Freeze', type: 'number' },
                { value: '14', type: 'number' },
                'junk',
                { type: 'adder' },
            ],
        });

        const response = await scan({ image: SMALL_JPEG });
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, {
            model: DEFAULT_MODEL,
            cards: [
                { value: '7', type: 'number' },
                { value: 'x2', type: 'multiplier' },
                { value: '+4', type: 'adder' },
                { value: '12', type: 'number' },
            ],
        });

        const [call] = fake.callsTo(':generateContent');
        assert.equal(call.url, `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}:generateContent`);
        assert.equal(call.init.method, 'POST');
        assert.equal(call.init.headers['x-goog-api-key'], API_KEY);
        assert.ok(!call.url.includes(API_KEY));

        const sent = JSON.parse(call.init.body);
        const [imagePart, textPart] = sent.contents[0].parts;
        assert.deepEqual(imagePart.inlineData, { mimeType: 'image/jpeg', data: 'aGVsbG8hISE=' });
        assert.match(textPart.text, /Flip 7/);
        assert.match(textPart.text, /Second Chance/);

        const format = sent.generationConfig.responseFormat.text;
        assert.equal(format.mimeType, 'APPLICATION_JSON');
        assert.equal(format.schema.type, 'object');
        assert.ok(format.schema.properties.cards.items.properties.value.enum.includes('+10'));
    });

    test('scan understands With a Vengeance cards', async () => {
        fake.generate = () => answerWith({
            cards: [
                { value: '13', type: 'number' },
                { value: '÷2', type: 'divisor' },
                { value: '/2', type: 'multiplier' },
                { value: '−6', type: 'adder' },
                { value: '-10', type: 'subtractor' },
            ],
        });

        const response = await scan({ image: SMALL_JPEG });
        assert.equal(response.status, 200);
        assert.deepEqual(response.body.cards, [
            { value: '13', type: 'number' },
            { value: '÷2', type: 'divisor' },
            { value: '÷2', type: 'divisor' },
            { value: '-6', type: 'subtractor' },
            { value: '-10', type: 'subtractor' },
        ]);

        const sent = JSON.parse(fake.callsTo(':generateContent')[0].init.body);
        const valueSchema = sent.generationConfig.responseFormat.text.schema.properties.cards.items.properties;
        assert.ok(valueSchema.value.enum.includes('÷2'));
        assert.ok(valueSchema.value.enum.includes('-10'));
        assert.ok(valueSchema.type.enum.includes('subtractor'));
        assert.match(sent.contents[0].parts[1].text, /never show 0/);
    });

    test('zero modifiers are dropped; unsigned modifiers get their symbol', async () => {
        fake.generate = () => answerWith({
            cards: [
                { value: '+0', type: 'adder' },
                { value: '0', type: 'adder' },
                { value: 'x0', type: 'multiplier' },
                { value: '-0', type: 'subtractor' },
                { value: '0', type: 'number' },
                { value: '4', type: 'adder' },
                { value: '8', type: 'subtractor' },
                { value: '7', type: 'adder' },
            ],
        });

        const response = await scan({ image: SMALL_JPEG });
        assert.deepEqual(response.body.cards, [
            { value: '0', type: 'number' },
            { value: '+4', type: 'adder' },
            { value: '-8', type: 'subtractor' },
            { value: '7', type: 'number' },
        ]);
    });

    test('scan uses a requested model when it is offered', async () => {
        const response = await scan({ image: SMALL_JPEG, model: 'gemini-3.6-flash' });
        assert.equal(response.status, 200);
        assert.equal(response.body.model, 'gemini-3.6-flash');
        assert.equal(fake.callsTo(':generateContent')[0].url.includes('/models/gemini-3.6-flash:generateContent'), true);
    });

    test('scan rejects a model that is not offered', async () => {
        for (const model of ['gemini-3.8-flash-tts', 'gpt-4o', '../../evil', 42]) {
            const response = await scan({ image: SMALL_JPEG, model });
            assert.equal(response.status, 400, String(model));
        }
        assert.equal(fake.callsTo(':generateContent').length, 0);
    });

    test('scan rejects bad images', async () => {
        const tooLarge = `data:image/png;base64,${'A'.repeat(Math.ceil((4 * 1024 * 1024 + 3) / 3) * 4)}`;
        const badImages = [
            undefined,
            42,
            'not a data url',
            'data:image/gif;base64,R0lGODlh',
            'data:text/plain;base64,aGVsbG8=',
            'data:image/jpeg;base64,abc',
            'data:image/jpeg;base64,',
            tooLarge,
        ];
        for (const image of badImages) {
            const response = await scan({ image });
            assert.equal(response.status, 400, String(image).slice(0, 40));
            assert.equal(typeof response.body.message, 'string');
        }

        const notObject = await scan([SMALL_JPEG]);
        assert.equal(notObject.status, 400);
        assert.equal(fake.callsTo(':generateContent').length, 0);
    });

    test('an upstream 429 becomes a 429 with a friendly message', async () => {
        fake.generate = () => jsonResponse(429, { error: { code: 429, message: 'Resource exhausted' } });
        const response = await scan({ image: SMALL_JPEG });
        assert.equal(response.status, 429);
        assert.match(response.body.message, /busy/);
    });

    test('other upstream failures become 502 without leaking details', async () => {
        fake.generate = () => jsonResponse(500, { error: { code: 500, message: `internal ${API_KEY}` } });
        const response = await scan({ image: SMALL_JPEG });
        assert.equal(response.status, 502);
        assert.ok(!JSON.stringify(response.body).includes(API_KEY));
    });

    test('an unknown model upstream (404) becomes 502 so the client can try another', async () => {
        fake.generate = () => jsonResponse(404, { error: { code: 404, message: 'models/x is not found' } });
        const response = await scan({ image: SMALL_JPEG });
        assert.equal(response.status, 502);
    });

    test('malformed upstream answers become 502', async () => {
        const malformedResponses = [
            () => jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'not json {' }] } }] }),
            () => answerWith({ notCards: [] }),
            () => jsonResponse(200, { candidates: [] }),
            () => jsonResponse(200, { promptFeedback: { blockReason: 'SAFETY' } }),
            () => new Response('<html>oops</html>', { status: 200 }),
        ];
        for (const respond of malformedResponses) {
            fake.generate = respond;
            const response = await scan({ image: SMALL_JPEG });
            assert.equal(response.status, 502);
        }
    });

    test('a network failure becomes 502', async () => {
        fake.generate = () => {
            throw new TypeError('fetch failed');
        };
        const response = await scan({ image: SMALL_JPEG });
        assert.equal(response.status, 502);
    });

    test('scans are rate-limited per user', async () => {
        const bobCookie = await devLogin(server.baseUrl, 'bob@example.com');
        for (let i = 0; i < 20; i++) {
            const response = await scan({ image: SMALL_JPEG }, bobCookie);
            assert.equal(response.status, 200, `scan ${i + 1}`);
        }

        const limited = await scan({ image: SMALL_JPEG }, bobCookie);
        assert.equal(limited.status, 429);
        assert.match(limited.body.message, /Too many scans/);

        // Other users are unaffected, and Bob may scan again after the window.
        const alice = await scan({ image: SMALL_JPEG });
        assert.equal(alice.status, 200);

        clock.time += 61 * 1000;
        const later = await scan({ image: SMALL_JPEG }, bobCookie);
        assert.equal(later.status, 200);
    });

    test('photo bodies above the global 1 MB limit are accepted', async () => {
        const threeMegabytesBase64 = 'A'.repeat(4 * 1024 * 1024);
        const response = await scan({ image: `data:image/webp;base64,${threeMegabytesBase64}` });
        assert.equal(response.status, 200);
    });

    // --- Scan modes ------------------------------------------------------

    function sentRequest(index = 0) {
        return JSON.parse(fake.callsTo(':generateContent')[index].init.body);
    }

    function sentPrompt(sent) {
        return sent.contents[0].parts[1].text;
    }

    function sentSchema(sent) {
        return sent.generationConfig.responseFormat.text.schema;
    }

    test('the classic prompt and schema are unchanged, byte for byte', async () => {
        await scan({ image: SMALL_JPEG });
        const sent = sentRequest();

        assert.equal(sha256(sentPrompt(sent)), CLASSIC_PROMPT_SHA256);
        assert.equal(sha256(JSON.stringify(sentSchema(sent))), CLASSIC_SCHEMA_SHA256);
    });

    test('the classic prompt for Gemma is unchanged, byte for byte', async () => {
        await scan({ image: SMALL_JPEG, model: 'gemma-4-31b-it' });
        const sent = sentRequest();

        assert.equal(sha256(sentPrompt(sent)), CLASSIC_GEMMA_PROMPT_SHA256);
        assert.equal(sent.generationConfig, undefined);
    });

    test('a missing or unknown mode uses the classic prompt and never errors', async () => {
        const unknownModes = ['classic', 'nonsense', 'VENGEANCE', '', 'constructor', '__proto__', 'toString', 42, null, {}, ['vengeance']];

        for (const [index, mode] of unknownModes.entries()) {
            const response = await scan({ image: SMALL_JPEG, mode });
            assert.equal(response.status, 200, String(mode));

            const sent = sentRequest(index);
            assert.equal(sha256(sentPrompt(sent)), CLASSIC_PROMPT_SHA256, String(mode));
            assert.equal(sha256(JSON.stringify(sentSchema(sent))), CLASSIC_SCHEMA_SHA256, String(mode));
        }
    });

    test('Vengeance sends its own prompt and a schema that reads before it classifies', async () => {
        const response = await scan({ image: SMALL_JPEG, mode: 'vengeance' });
        assert.equal(response.status, 200);

        const sent = sentRequest();
        assert.match(sentPrompt(sent), /Flip 7: With a Vengeance/);
        assert.match(sentPrompt(sent), /YOU MAY HAVE ONE OTHER 13/);
        assert.doesNotMatch(sentPrompt(sent), /Second Chance/);

        const schema = sentSchema(sent);
        assert.deepEqual(Object.keys(schema.properties), ['visible_card_count', 'cards']);
        assert.deepEqual(schema.propertyOrdering, ['visible_card_count', 'cards']);
        assert.equal(schema.properties.visible_card_count.type, 'integer');

        const cardSchema = schema.properties.cards.items;
        assert.deepEqual(Object.keys(cardSchema.properties), ['printed_text', 'label']);
        assert.deepEqual(cardSchema.propertyOrdering, ['printed_text', 'label']);
        assert.deepEqual(cardSchema.required, ['printed_text', 'label']);
        assert.deepEqual(cardSchema.properties.label.enum, [
            ...Array.from({ length: 13 }, (_, index) => `N_${index + 1}`),
            'THE_ZERO', 'UNLUCKY_7', 'LUCKY_13',
            'DIV_2', 'MINUS_2', 'MINUS_4', 'MINUS_6', 'MINUS_8', 'MINUS_10', 'ACTION',
        ]);
    });

    test('Brutal gets the same prompt and schema as Vengeance', async () => {
        await scan({ image: SMALL_JPEG, mode: 'vengeance' });
        await scan({ image: SMALL_JPEG, mode: 'brutal' });

        const vengeance = sentRequest(0);
        const brutal = sentRequest(1);
        assert.equal(sentPrompt(brutal), sentPrompt(vengeance));
        assert.deepEqual(sentSchema(brutal), sentSchema(vengeance));
    });

    test('Vengeance labels map to the cards the client expects', async () => {
        const expectedByLabel = {
            THE_ZERO: { value: '0', type: 'special' },
            UNLUCKY_7: { value: '7', type: 'special' },
            LUCKY_13: { value: '13', type: 'special' },
            DIV_2: { value: '÷2', type: 'divisor' },
            MINUS_2: { value: '-2', type: 'subtractor' },
            MINUS_4: { value: '-4', type: 'subtractor' },
            MINUS_6: { value: '-6', type: 'subtractor' },
            MINUS_8: { value: '-8', type: 'subtractor' },
            MINUS_10: { value: '-10', type: 'subtractor' },
        };
        for (let number = 1; number <= 13; number++) {
            expectedByLabel[`N_${number}`] = { value: String(number), type: 'number' };
        }

        const labels = Object.keys(expectedByLabel);
        fake.generate = () => answerWith({
            visible_card_count: labels.length,
            cards: labels.map((label) => ({ printed_text: 'whatever is printed', label })),
        });

        const response = await scan({ image: SMALL_JPEG, mode: 'vengeance' });
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, { model: DEFAULT_MODEL, cards: Object.values(expectedByLabel) });
    });

    test('Vengeance keeps duplicates, as a bust is the scorer\'s call', async () => {
        fake.generate = () => answerWith({
            cards: [{ printed_text: 'THIRTEEN', label: 'N_13' }, { printed_text: 'THIRTEEN', label: 'N_13' }],
        });

        const response = await scan({ image: SMALL_JPEG, mode: 'vengeance' });
        assert.deepEqual(response.body.cards, [{ value: '13', type: 'number' }, { value: '13', type: 'number' }]);
    });

    test('Vengeance trusts the printed word on a 6 or 9, as an upside-down 6 looks like a 9', async () => {
        fake.generate = () => answerWith({
            cards: [
                { printed_text: 'SIX', label: 'N_9' },
                { printed_text: 'nine 9', label: 'N_6' },
            ],
        });

        const response = await scan({ image: SMALL_JPEG, mode: 'vengeance' });
        assert.deepEqual(response.body.cards, [{ value: '6', type: 'number' }, { value: '9', type: 'number' }]);
    });

    test('Vengeance keeps the label when the printed words give no single answer', async () => {
        fake.generate = () => answerWith({
            cards: [
                { printed_text: '6', label: 'N_6' },
                { printed_text: 'SIX NINE', label: 'N_9' },
            ],
        });

        const response = await scan({ image: SMALL_JPEG, mode: 'vengeance' });
        assert.deepEqual(response.body.cards, [{ value: '6', type: 'number' }, { value: '9', type: 'number' }]);
    });

    test('Vengeance never lets a printed word change a special card or a modifier', async () => {
        fake.generate = () => answerWith({
            cards: [
                { printed_text: 'YOU MAY HAVE ONE OTHER 13', label: 'LUCKY_13' },
                { printed_text: 'SIX', label: 'MINUS_6' },
            ],
        });

        const response = await scan({ image: SMALL_JPEG, mode: 'vengeance' });
        assert.deepEqual(response.body.cards, [{ value: '13', type: 'special' }, { value: '-6', type: 'subtractor' }]);
    });

    test('Vengeance drops action cards, and rejects x2, +N and anything else instead of guessing', async () => {
        fake.generate = () => answerWith({
            visible_card_count: 11,
            cards: [
                { printed_text: 'Swap', label: 'ACTION' },
                { printed_text: 'x2', label: 'x2' },
                { printed_text: '+4', label: 'PLUS_4' },
                { printed_text: '-3', label: 'MINUS_3' },
                { printed_text: '0', label: 'N_0' },
                { printed_text: '14', label: 'N_14' },
                { printed_text: 'x', label: 'constructor' },
                { printed_text: 'x', label: 7 },
                { value: 'x2', type: 'multiplier' },
                { value: '+4', type: 'adder' },
                'junk',
                { printed_text: 'FIVE', label: 'N_5' },
            ],
        });

        const response = await scan({ image: SMALL_JPEG, mode: 'vengeance' });
        assert.equal(response.status, 200);
        assert.deepEqual(response.body.cards, [{ value: '5', type: 'number' }]);
    });

    test('Vengeance ignores what the model says is printed: the label decides', async () => {
        fake.generate = () => answerWith({ cards: [{ printed_text: 'YOU MAY HAVE ONE OTHER 13', label: 'N_13' }, { label: 'LUCKY_13' }] });

        const response = await scan({ image: SMALL_JPEG, mode: 'vengeance' });
        assert.deepEqual(response.body.cards, [{ value: '13', type: 'number' }, { value: '13', type: 'special' }]);
    });

    test('Gemma on Vengeance gets the format in the prompt, and its loose answers still map', async () => {
        fake.generate = () => jsonResponse(200, {
            candidates: [{
                content: { role: 'model', parts: [{ text: '```json\n{"visible_card_count":2,"cards":[{"printed_text":"13","label":" lucky_13 "},{"printed_text":"Steal","label":"action"}]}\n```' }] },
                finishReason: 'STOP',
            }],
        });

        const response = await scan({ image: SMALL_JPEG, model: 'gemma-4-31b-it', mode: 'vengeance' });
        assert.equal(response.status, 200);
        assert.deepEqual(response.body.cards, [{ value: '13', type: 'special' }]);

        const sent = sentRequest();
        assert.equal(sent.generationConfig, undefined);
        assert.match(sentPrompt(sent), /YOU MAY HAVE ONE OTHER 13/);
        assert.match(sentPrompt(sent), /Answer with only a JSON object/);
        assert.match(sentPrompt(sent), /"printed_text"/);
        assert.match(sentPrompt(sent), /LUCKY_13/);
    });

    test('a Vengeance answer with no card list becomes a 502', async () => {
        fake.generate = () => answerWith({ visible_card_count: 3 });

        const response = await scan({ image: SMALL_JPEG, mode: 'vengeance' });
        assert.equal(response.status, 502);
    });

    test('a Vengeance answer is capped like a classic one', async () => {
        const tooManyCards = Array.from({ length: 45 }, () => ({ printed_text: 'ONE', label: 'N_1' }));
        fake.generate = () => answerWith({ cards: tooManyCards });

        const response = await scan({ image: SMALL_JPEG, mode: 'vengeance' });
        assert.equal(response.body.cards.length, 40);
    });
});

// --- Default model missing from the list ---------------------------------

describe('AI routes when the default model is not listed', () => {
    let server;
    let cookie;

    before(async () => {
        const fake = createFakeGemini();
        server = await startTestServer({
            env: { GEMINI_API_KEY: API_KEY, GEMINI_MODEL: 'gemini-9-flash' },
            geminiFetch: (url, init) => fake.fetch(url, init),
        });
        cookie = await devLogin(server.baseUrl, 'alice@example.com');
    });

    after(async () => {
        await server.stop();
    });

    test('the configured default is still offered first', async () => {
        const response = await api(server.baseUrl, 'GET', '/api/ai/config', { cookie });
        assert.equal(response.body.default_model, 'gemini-9-flash');
        assert.deepEqual(response.body.models[0], { id: 'gemini-9-flash', display_name: 'gemini-9-flash' });
        assert.equal(response.body.models[1].id, 'gemini-3.8-flash');
    });
});

describe('AI scan upstream timeouts', () => {
    let server;
    let cookie;

    before(async () => {
        const fake = createFakeGemini();
        server = await startTestServer({
            env: { GEMINI_API_KEY: API_KEY },
            geminiFetch: (url, init) => {
                if (String(url).includes(':generateContent')) {
                    throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
                }
                return fake.fetch(url, init);
            },
        });
        cookie = await devLogin(server.baseUrl, 'alice@example.com');
    });

    after(async () => {
        await server.stop();
    });

    test('a Gemini timeout becomes a 502 asking to try again', async () => {
        const response = await api(server.baseUrl, 'POST', '/api/ai/scan-cards', { cookie, body: { image: SMALL_JPEG } });
        assert.equal(response.status, 502);
        assert.match(response.body.message, /too long/);
    });
});
