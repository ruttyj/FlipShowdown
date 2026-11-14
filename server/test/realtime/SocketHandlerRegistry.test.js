import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SocketHandlerRegistry } from '../../src/realtime/SocketHandlerRegistry.js';

describe('SocketHandlerRegistry', () => {
    const hello = { type: 'hello', handle() {} };
    const rooms = { type: 'rooms', handle() {} };

    test('finds each handler by its type', () => {
        const registry = new SocketHandlerRegistry([hello, rooms]);

        assert.equal(registry.get('hello'), hello);
        assert.equal(registry.get('rooms'), rooms);
    });

    test('an unknown type, a prototype name or a type that is not a string finds nothing', () => {
        const registry = new SocketHandlerRegistry([hello]);

        assert.equal(registry.get('ping'), null);
        assert.equal(registry.get('toString'), null);
        assert.equal(registry.get('__proto__'), null);
        assert.equal(registry.get(['hello']), null);
        assert.equal(registry.get(undefined), null);
    });

    test('a type registered twice throws', () => {
        const registry = new SocketHandlerRegistry([hello]);

        assert.throws(() => registry.add({ type: 'hello', handle() {} }), /already registered: hello/);
    });
});
