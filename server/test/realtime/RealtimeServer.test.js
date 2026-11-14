import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, test } from 'node:test';
import { RealtimeServer } from '../../src/realtime/RealtimeServer.js';
import { SocketHandlerRegistry } from '../../src/realtime/SocketHandlerRegistry.js';
import { createRecordingParts } from './recordingParts.js';

// RealtimeServer's handling of accepted sockets, over a fake WebSocketServer and recorded
// stand-ins for the managers. The upgrade itself (paths, 401s, socket errors) is covered by
// realtime.test against real and fake upgrade sockets.

describe('RealtimeServer sockets', () => {
    let calls;
    let results;
    let parts;
    let webSocketServer;
    let server;
    let handled;
    let socket;
    let hooks;

    beforeEach(() => {
        ({ calls, results, parts } = createRecordingParts());
        webSocketServer = new EventEmitter();
        webSocketServer.closeCalls = 0;
        webSocketServer.close = () => {
            webSocketServer.closeCalls += 1;
        };
        handled = [];
        const hello = {
            type: 'hello',
            handle: (handledSocket, message) => handled.push([handledSocket, message]),
        };
        server = new RealtimeServer({
            webSocketServer,
            authenticate: () => null,
            logger: console,
            ...parts,
            handlers: new SocketHandlerRegistry([hello]),
        });

        socket = { identity: { email: 'ann@example.com' } };
        webSocketServer.emit('connection', socket);
        hooks = calls.find((call) => call[0] === 'connections.register')[2];
        calls.length = 0;
    });

    test('a new socket is registered for subscriptions, then for its connection', () => {
        const other = {};
        webSocketServer.emit('connection', other);

        assert.deepEqual(calls.map((call) => [call[0], call[1]]), [
            ['subscriptions.register', other],
            ['connections.register', other],
        ]);
    });

    test('a message goes to the handler for its type, parsed', () => {
        hooks.onMessage(Buffer.from('{"type":"hello","rooms":["r1"]}'));

        assert.deepEqual(handled, [[socket, { type: 'hello', rooms: ['r1'] }]]);
    });

    test('anything else is ignored: not JSON, JSON null, no type or an unknown type', () => {
        for (const text of ['{oops', 'null', '{}', '{"type":"dance"}', '{"type":["hello"]}']) {
            hooks.onMessage(Buffer.from(text));
        }

        assert.deepEqual(handled, []);
        assert.deepEqual(calls, []);
    });

    test('ping is answered with pong', () => {
        results['connections.markHeard'] = false;

        hooks.onMessage(Buffer.from('{"type":"ping"}'));

        assert.deepEqual(calls, [
            ['connections.markHeard', socket],
            ['connections.send', socket, { type: 'pong' }],
        ]);
    });

    test('a ping from a socket that had gone stale updates its rooms first', () => {
        const rooms = new Set(['r1']);
        results['connections.markHeard'] = true;
        results['subscriptions.roomsOf'] = rooms;

        hooks.onMessage(Buffer.from('{"type":"ping"}'));

        assert.deepEqual(calls, [
            ['connections.markHeard', socket],
            ['subscriptions.roomsOf', socket],
            ['presence.refreshRooms', rooms],
            ['connections.send', socket, { type: 'pong' }],
        ]);
    });

    test('a closed socket is unsubscribed, lets go of its holds, and its rooms update', () => {
        const rooms = new Set(['r1', 'r2']);
        results['subscriptions.unsubscribeAll'] = rooms;

        hooks.onClose();

        assert.deepEqual(calls, [
            ['subscriptions.unsubscribeAll', socket],
            ['votes.dropAllHolds', socket],
            ['presence.refreshRooms', rooms],
        ]);
    });

    test('close closes the WebSocketServer', () => {
        server.close();

        assert.equal(webSocketServer.closeCalls, 1);
    });
});
