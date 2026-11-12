import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_RETRY_POLICY,
    initialRetryState,
    recordConnected,
    recordFailure,
    retryDelayMs,
    didUrlChange,
} from '../src/main/retryPolicy.js';

// --- Defaults (decision 14) ---

test('the default policy retries three times', () => {
    assert.equal(DEFAULT_RETRY_POLICY.maxRetries, 3);
});

test('the initial state has no failures and no connection', () => {
    assert.deepEqual(initialRetryState(), { failureCount: 0, connectedAt: null });
});

// --- retryDelayMs ---

test('retry delays back off exponentially from the base delay', () => {
    const policy = { ...DEFAULT_RETRY_POLICY, baseDelayMs: 1000, backoffFactor: 2 };

    assert.equal(retryDelayMs(1, policy), 1000);
    assert.equal(retryDelayMs(2, policy), 2000);
    assert.equal(retryDelayMs(3, policy), 4000);
});

test('retry delays are capped at maxDelayMs', () => {
    const policy = { ...DEFAULT_RETRY_POLICY, baseDelayMs: 1000, backoffFactor: 10, maxDelayMs: 5000 };

    assert.equal(retryDelayMs(3, policy), 5000);
});

test('retryDelayMs uses the default policy when none is given', () => {
    assert.equal(retryDelayMs(1), DEFAULT_RETRY_POLICY.baseDelayMs);
});

// --- recordFailure ---

test('the first three failures each retry with a growing delay', () => {
    let state = initialRetryState();
    const delays = [];

    for (let attempt = 1; attempt <= 3; attempt++) {
        const result = recordFailure(state, attempt * 100);
        assert.equal(result.decision.type, 'retry');
        assert.equal(result.decision.attempt, attempt);
        delays.push(result.decision.delayMs);
        state = result.state;
    }

    assert.ok(delays[0] < delays[1] && delays[1] < delays[2], `delays should grow: ${delays}`);
});

test('the fourth failure in a row gives up', () => {
    let state = initialRetryState();
    for (let attempt = 1; attempt <= 3; attempt++) {
        state = recordFailure(state, 0).state;
    }

    const result = recordFailure(state, 0);

    assert.deepEqual(result.decision, { type: 'give-up', failures: 4 });
});

test('a custom maxRetries of zero gives up on the first failure', () => {
    const policy = { ...DEFAULT_RETRY_POLICY, maxRetries: 0 };

    assert.equal(recordFailure(initialRetryState(), 0, policy).decision.type, 'give-up');
});

test('recordFailure does not mutate the state it is given', () => {
    const state = initialRetryState();

    recordFailure(state, 0);

    assert.deepEqual(state, initialRetryState());
});

test('a connection that drops before it was stable keeps counting failures', () => {
    const policy = { ...DEFAULT_RETRY_POLICY, stableAfterMs: 60_000 };
    let state = initialRetryState();
    state = recordFailure(state, 0, policy).state;
    state = recordFailure(state, 1000, policy).state;
    state = recordConnected(state, 5000);

    const result = recordFailure(state, 10_000, policy);

    assert.equal(result.decision.type, 'retry');
    assert.equal(result.decision.attempt, 3);
});

test('a connection that stayed up past stableAfterMs starts the count afresh', () => {
    const policy = { ...DEFAULT_RETRY_POLICY, stableAfterMs: 60_000 };
    let state = initialRetryState();
    for (let attempt = 1; attempt <= 3; attempt++) {
        state = recordFailure(state, 0, policy).state;
    }
    state = recordConnected(state, 1000);

    const result = recordFailure(state, 61_000, policy);

    assert.equal(result.decision.type, 'retry');
    assert.equal(result.decision.attempt, 1);
    assert.equal(result.state.failureCount, 1);
});

test('a failure clears the connection time so the next failure is not treated as stable', () => {
    const policy = { ...DEFAULT_RETRY_POLICY, stableAfterMs: 60_000 };
    let state = recordConnected(initialRetryState(), 0);
    state = recordFailure(state, 100_000, policy).state;

    assert.equal(state.connectedAt, null);
    assert.deepEqual(recordFailure(state, 300_000, policy).decision, {
        type: 'retry',
        attempt: 2,
        delayMs: retryDelayMs(2, policy),
    });
});

test('recordConnected keeps the failure count', () => {
    let state = recordFailure(initialRetryState(), 0).state;

    state = recordConnected(state, 42);

    assert.deepEqual(state, { failureCount: 1, connectedAt: 42 });
});

// --- didUrlChange ---

test('the first URL of a session is not a change', () => {
    assert.equal(didUrlChange(null, 'https://a-b.trycloudflare.com'), false);
});

test('a restart that brings a different URL is a change', () => {
    assert.equal(didUrlChange('https://a-b.trycloudflare.com', 'https://c-d.trycloudflare.com'), true);
});

test('the same URL again is not a change', () => {
    assert.equal(didUrlChange('https://a-b.trycloudflare.com', 'https://a-b.trycloudflare.com'), false);
});

test('losing the URL (no new one yet) is not a change', () => {
    assert.equal(didUrlChange('https://a-b.trycloudflare.com', null), false);
});
