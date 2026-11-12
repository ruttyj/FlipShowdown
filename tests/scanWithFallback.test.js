// Tests for the AI scan model fallback. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanWithFallback } from '../src/lib/scanWithFallback.js';

// --- Fixtures ----------------------------------------------------------------

const MODELS = [
    { id: 'first', display_name: 'First' },
    { id: 'second', display_name: 'Second' },
    { id: 'third', display_name: 'Third' },
];

function statusError(status, message = `status ${status}`) {
    const error = new Error(message);
    error.status = status;
    return error;
}

// Answers each call in turn: an Error is thrown, anything else is returned.
function makeDeps(answers) {
    const calls = [];
    const warnings = [];
    return {
        calls,
        warnings,
        deps: {
            scanCards: async (image, modelId) => {
                calls.push({ image, modelId });
                const answer = answers[calls.length - 1];
                if (answer instanceof Error) {
                    throw answer;
                }
                return answer;
            },
            toast: { warning: (message) => warnings.push(message) },
        },
    };
}

// The fallback logs every failure; keep the test output quiet.
function silenceConsoleError(run) {
    const original = console.error;
    console.error = () => {};
    return run().finally(() => {
        console.error = original;
    });
}

// --- Tests -------------------------------------------------------------------

test('returns the first success without trying other models', async () => {
    const result = { cards: [{ value: '3', type: 'number' }], model: 'first' };
    const { deps, calls, warnings } = makeDeps([result]);

    assert.equal(await scanWithFallback('img', MODELS, deps), result);
    assert.deepEqual(calls, [{ image: 'img', modelId: 'first' }]);
    assert.deepEqual(warnings, []);
});

test('a retryable status moves to the next model with a warning', async () => {
    const result = { cards: [], model: 'second' };
    const { deps, calls, warnings } = makeDeps([statusError(502), result]);

    await silenceConsoleError(async () => {
        assert.equal(await scanWithFallback('img', MODELS, deps), result);
    });
    assert.deepEqual(calls.map((call) => call.modelId), ['first', 'second']);
    assert.deepEqual(warnings, ['First failed, trying next model...']);
});

test('a non-retryable status throws at once', async () => {
    const error = statusError(400);
    const { deps, calls, warnings } = makeDeps([error]);

    await silenceConsoleError(async () => {
        await assert.rejects(scanWithFallback('img', MODELS, deps), (thrown) => thrown === error);
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(warnings, []);
});

test('the last model\'s error is thrown, without a warning for it', async () => {
    const lastError = statusError(502, 'last');
    const { deps, calls, warnings } = makeDeps([statusError(502), lastError]);

    await silenceConsoleError(async () => {
        await assert.rejects(
            scanWithFallback('img', MODELS.slice(0, 2), deps),
            (thrown) => thrown === lastError,
        );
    });
    assert.equal(calls.length, 2);
    assert.equal(warnings.length, 1);
});

test('an empty model list throws "No AI models are available"', async () => {
    const { deps, calls } = makeDeps([]);

    await assert.rejects(scanWithFallback('img', [], deps), { message: 'No AI models are available' });
    assert.equal(calls.length, 0);
});

test('every model is asked with the same scan mode', async () => {
    const answers = [statusError(502), { cards: [], model: 'second' }];
    const modes = [];
    const scanCards = async (_image, _modelId, scanMode) => {
        modes.push(scanMode);
        const answer = answers.shift();
        if (answer instanceof Error) {
            throw answer;
        }
        return answer;
    };
    const toast = { warning: () => {} };

    await silenceConsoleError(async () => {
        await scanWithFallback('img', MODELS, { scanCards, toast, scanMode: 'vengeance' });
    });

    assert.deepEqual(modes, ['vengeance', 'vengeance']);
});
