import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ActionRegistry } from '../../src/actions/ActionRegistry.js';

function handler(access) {
    return { access, allowedStatuses: null, handle() {} };
}

describe('ActionRegistry', () => {
    test('gives back the handler registered under a name', () => {
        const registry = new ActionRegistry();
        const join = handler('signed_in');
        registry.add('join', join);

        assert.equal(registry.get('join'), join);
    });

    test('an unknown name, including one on Object.prototype, gives null', () => {
        const registry = new ActionRegistry();
        registry.add('join', handler('signed_in'));

        assert.equal(registry.get('leave'), null);
        assert.equal(registry.get('toString'), null);
        assert.equal(registry.get('__proto__'), null);
    });

    test('refuses a second handler for a name already taken', () => {
        const registry = new ActionRegistry();
        const first = handler('host');
        registry.add('start', first);

        assert.throws(() => registry.add('start', handler('signed_in')), /Action already registered: start/);
        assert.equal(registry.get('start'), first);
    });
});
