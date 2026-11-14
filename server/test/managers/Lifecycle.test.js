import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Lifecycle } from '../../src/managers/Lifecycle.js';
import { createRecordingLogger } from './fakeSockets.js';

describe('Lifecycle', () => {
    test('runGuarded runs the handler', () => {
        const lifecycle = new Lifecycle({ logger: createRecordingLogger() });
        let runs = 0;

        lifecycle.runGuarded('test', () => {
            runs += 1;
        });

        assert.equal(runs, 1);
    });

    test('a throw is logged with its label, not rethrown', () => {
        const logger = createRecordingLogger();
        const lifecycle = new Lifecycle({ logger });
        const error = new Error('boom');

        lifecycle.runGuarded('vote', () => {
            throw error;
        });

        assert.deepEqual(logger.calls, [['error', 'Realtime vote failed', error]]);
    });

    test('once closed, handlers are skipped', () => {
        const lifecycle = new Lifecycle({ logger: createRecordingLogger() });
        let runs = 0;

        lifecycle.close();
        lifecycle.runGuarded('test', () => {
            runs += 1;
        });

        assert.equal(lifecycle.isClosed, true);
        assert.equal(runs, 0);
    });
});
