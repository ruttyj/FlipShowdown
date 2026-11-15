import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { AiController } from '../../src/http/controllers/AiController.js';
import { ScanOutcome } from '../../src/services/ai/ScanService.js';
import { serveApp, signedInAs } from './httpHarness.js';

// AiController over a fake ScanService: the scan route's order (enabled, rate limit, its own body
// parser, body check) and how results are answered. ai.test.js covers the real service.

const USER = { email: 'ann@example.com' };

/** A fake ScanService; `enabled`, `underLimit` and `result` decide its answers. */
function createFakeScans() {
    const fake = {
        enabled: true,
        underLimit: true,
        result: { outcome: ScanOutcome.SCANNED, cards: [], model: 'm1' },
        calls: [],
        isEnabled: () => fake.enabled,
        async getConfig() {
            return { enabled: fake.enabled };
        },
        tryStartScan(email) {
            fake.calls.push(['tryStartScan', email]);
            return fake.underLimit;
        },
        async scan(request) {
            fake.calls.push(['scan', request]);
            return fake.result;
        },
    };
    return fake;
}

describe('AiController', () => {
    let scans;
    let harness;

    before(async () => {
        scans = createFakeScans();
        const controller = new AiController({ scans });
        // No JSON parser in front, as in the server: the scan route brings its own.
        harness = await serveApp((app) => {
            app.use('/api/ai', signedInAs(USER), controller.router());
        });
    });

    beforeEach(() => {
        scans.enabled = true;
        scans.underLimit = true;
        scans.result = { outcome: ScanOutcome.SCANNED, cards: [], model: 'm1' };
        scans.calls = [];
    });

    after(async () => {
        await harness.close();
    });

    test('config answers the service config', async () => {
        const response = await harness.request('GET', '/api/ai/config');

        assert.equal(response.status, 200);
        assert.deepEqual(response.body, { enabled: true });
    });

    test('a scan passes the parsed body to the service and answers the cards', async () => {
        const response = await harness.request('POST', '/api/ai/scan-cards', { body: { image: 'x', mode: 'm' } });

        assert.equal(response.status, 200);
        assert.equal(response.text, '{"cards":[],"model":"m1"}');
        assert.deepEqual(scans.calls, [['tryStartScan', USER.email], ['scan', { image: 'x', mode: 'm' }]]);
    });

    test('a failed scan is answered with the status for its outcome and the message', async () => {
        const cases = [
            [ScanOutcome.INVALID_REQUEST, 400],
            [ScanOutcome.AI_BUSY, 429],
            [ScanOutcome.AI_FAILED, 502],
        ];
        for (const [outcome, status] of cases) {
            scans.result = { outcome, message: 'nope' };

            const response = await harness.request('POST', '/api/ai/scan-cards', { body: { image: 'x' } });

            assert.equal(response.status, status, outcome);
            assert.deepEqual(response.body, { message: 'nope' });
        }
    });

    test('a scan while AI is off is a 503 that does not count against the limit', async () => {
        scans.enabled = false;

        const response = await harness.request('POST', '/api/ai/scan-cards', { body: {} });

        assert.equal(response.status, 503);
        assert.deepEqual(response.body, { message: 'AI card scanning is not set up on this server' });
        assert.deepEqual(scans.calls, []);
    });

    test('a scan over the rate limit is a 429 before its body is parsed', async () => {
        scans.underLimit = false;

        const response = await harness.request('POST', '/api/ai/scan-cards', {
            body: '{ not json',
            headers: { 'content-type': 'application/json' },
        });

        assert.equal(response.status, 429);
        assert.deepEqual(response.body, { message: 'Too many scans. Wait a minute and try again.' });
    });

    test('a body that is not an object is a 400 and is not scanned', async () => {
        const response = await harness.request('POST', '/api/ai/scan-cards', { body: [1] });

        assert.equal(response.status, 400);
        assert.deepEqual(response.body, { message: 'Body must be a JSON object with an image data URL' });
        assert.deepEqual(scans.calls.map((call) => call[0]), ['tryStartScan']);
    });

    test('the scan route takes bodies over the global 1 MB limit, up to 6 MB', async () => {
        const image = 'a'.repeat(2 * 1024 * 1024);

        const accepted = await harness.request('POST', '/api/ai/scan-cards', { body: { image } });
        assert.equal(accepted.status, 200);

        const tooLarge = await harness.request('POST', '/api/ai/scan-cards', { body: { image: 'a'.repeat(7 * 1024 * 1024) } });
        // The harness's final handler answers every error with 500 and its message.
        assert.equal(tooLarge.status, 500);
        assert.match(tooLarge.body.message, /too large/i);
    });
});
