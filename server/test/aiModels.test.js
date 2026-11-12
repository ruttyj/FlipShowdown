import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createModelCatalog, selectScanningModels, supportsStructuredOutput } from '../src/aiModels.js';

function model(id, methods = ['generateContent'], displayName) {
    return { name: `models/${id}`, displayName, supportedGenerationMethods: methods };
}

function idsOf(models) {
    return models.map((entry) => entry.id);
}

describe('selectScanningModels ranking', () => {
    test('stable models sort before preview and experimental ones of the same tier', () => {
        const raw = [
            model('gemini-3.0-flash-preview'),
            model('gemini-3.0-flash-exp'),
            model('gemini-3.0-flash'),
        ];
        const ids = idsOf(selectScanningModels(raw, 'other'));
        assert.deepEqual(ids, ['other', 'gemini-3.0-flash', 'gemini-3.0-flash-exp', 'gemini-3.0-flash-preview']);
    });

    test('a newer version beats an older one, then Flash > Flash-Lite > Pro > other', () => {
        const raw = [
            model('gemini-2.5-flash'),
            model('gemini-3.0-pro'),
            model('gemini-3.0-flash-lite'),
            model('gemini-3.0-flash'),
            model('gemini-3.0-ultra'),
        ];
        const ids = idsOf(selectScanningModels(raw, 'x'));
        assert.deepEqual(ids, ['x', 'gemini-3.0-flash', 'gemini-3.0-flash-lite', 'gemini-3.0-pro', 'gemini-3.0-ultra', 'gemini-2.5-flash']);
    });

    test('models without a version (latest aliases) sort last among Gemini; ties break by id', () => {
        const raw = [
            model('gemini-flash-latest'),
            model('gemini-3.0-flash-b'),
            model('gemini-3.0-flash-a'),
        ];
        const ids = idsOf(selectScanningModels(raw, 'x'));
        assert.deepEqual(ids, ['x', 'gemini-3.0-flash-a', 'gemini-3.0-flash-b', 'gemini-flash-latest']);
    });

    test('Gemini always comes before Gemma, whatever the version', () => {
        const raw = [model('gemma-4-31b-it'), model('gemini-1.5-flash')];
        assert.deepEqual(idsOf(selectScanningModels(raw, 'x')), ['x', 'gemini-1.5-flash', 'gemma-4-31b-it']);
    });
});

describe('selectScanningModels filtering', () => {
    test('Gemma without vision is excluded; Gemma with vision is kept', () => {
        const raw = [
            model('gemma-3-1b-it'),
            model('gemma-3n-e4b-it'),
            model('gemma-2-9b-it'),
            model('gemma-3-12b-it'),
            model('gemma-12-big-it'),
        ];
        assert.deepEqual(idsOf(selectScanningModels(raw, 'x')), ['x', 'gemma-12-big-it', 'gemma-3-12b-it']);
    });

    test('models lacking generateContent, unsuitable ones and other families are excluded', () => {
        const raw = [
            model('gemini-3.0-live', ['bidiGenerateContent']),
            model('gemini-3.0-flash-tts'),
            model('palm-2'),
            model('gemini-3.0-flash'),
            { name: 'models/gemini-3.0-pro' },
            { name: 'models/gemini-3.0-pro', supportedGenerationMethods: 'generateContent' },
            {},
        ];
        assert.deepEqual(idsOf(selectScanningModels(raw, 'x')), ['x', 'gemini-3.0-flash']);
    });

    test('duplicates are listed once; display name falls back to the id', () => {
        const raw = [model('gemini-3.0-flash', ['generateContent'], 'Flash'), model('gemini-3.0-flash')];
        const models = selectScanningModels(raw, 'gemini-3.0-flash');
        assert.deepEqual(models, [{ id: 'gemini-3.0-flash', display_name: 'Flash' }]);
        assert.deepEqual(selectScanningModels([model('gemini-3.0-pro')], 'x')[1], { id: 'gemini-3.0-pro', display_name: 'gemini-3.0-pro' });
    });

    test('the default moves to the front even when it ranks low', () => {
        const raw = [model('gemini-3.0-flash'), model('gemini-1.0-pro')];
        assert.deepEqual(idsOf(selectScanningModels(raw, 'gemini-1.0-pro')), ['gemini-1.0-pro', 'gemini-3.0-flash']);
    });

    test('structured output is supported for Gemini only', () => {
        assert.equal(supportsStructuredOutput('gemini-3.0-flash'), true);
        assert.equal(supportsStructuredOutput('gemma-4-31b-it'), false);
    });
});

describe('createModelCatalog', () => {
    const logger = { warn() {} };

    test('caches for an hour, then refetches', async () => {
        let time = 0;
        let calls = 0;
        const client = {
            async listModels() {
                calls += 1;
                return [model('gemini-3.0-flash')];
            },
        };
        const catalog = createModelCatalog({ client, defaultModel: 'x', logger, now: () => time });
        await catalog.getModels();
        time = 59 * 60 * 1000;
        await catalog.getModels();
        assert.equal(calls, 1);
        time = 61 * 60 * 1000;
        await catalog.getModels();
        assert.equal(calls, 2);
    });

    test('concurrent callers share one fetch', async () => {
        let calls = 0;
        const client = {
            async listModels() {
                calls += 1;
                return [];
            },
        };
        const catalog = createModelCatalog({ client, defaultModel: 'x', logger });
        const [first, second] = await Promise.all([catalog.getModels(), catalog.getModels()]);
        assert.equal(calls, 1);
        assert.equal(first, second);
    });

    test('a failure falls back to the default, logs the detail or message, and retries after a minute', async () => {
        let time = 0;
        let calls = 0;
        const warnings = [];
        const failures = [{ detail: 'quota' }, new Error('boom')];
        const client = {
            async listModels() {
                calls += 1;
                throw failures[calls - 1] || new Error('again');
            },
        };
        const catalog = createModelCatalog({ client, defaultModel: 'x', logger: { warn: (text) => warnings.push(text) }, now: () => time });

        assert.deepEqual(await catalog.getModels(), [{ id: 'x', display_name: 'x' }]);
        assert.match(warnings[0], /quota/);

        time = 30_000;
        await catalog.getModels();
        assert.equal(calls, 1);

        time = 61_000;
        await catalog.getModels();
        assert.equal(calls, 2);
        assert.match(warnings[1], /boom/);
    });
});
