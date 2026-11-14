import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { WebSocket } from 'ws';
import { LIVE_WINDOW_MS } from '../../../shared/realtimeProtocol.js';
import { Clock } from '../../src/domain/clock.js';
import { ConnectionManager } from '../../src/managers/ConnectionManager.js';
import { FakeSocket, createRecordingLogger } from './fakeSockets.js';

// ConnectionManager on fake sockets and a settable clock. The timers run on node:test's mock
// timers, so a test moves time on with mock.timers.tick.

const HEARTBEAT_MS = 100;
const LIVENESS_MS = 10;

describe('ConnectionManager', () => {
    let time;
    let logger;
    let connections;

    beforeEach(() => {
        time = 1_000_000;
        logger = createRecordingLogger();
        connections = new ConnectionManager({
            clients: new Set(),
            clock: new Clock(() => time),
            logger,
            heartbeatIntervalMs: HEARTBEAT_MS,
            livenessCheckIntervalMs: LIVENESS_MS,
        });
    });

    afterEach(() => {
        mock.timers.reset();
    });

    /** A fake socket registered with recording hooks; also added to the client set. */
    function connect(hooks = {}) {
        const socket = new FakeSocket();
        connections.clients.add(socket);
        connections.register(socket, {
            onMessage: hooks.onMessage ?? (() => {}),
            onClose: hooks.onClose ?? (() => {}),
        });
        return socket;
    }

    describe('register', () => {
        test('a new socket is alive, live and heard now', () => {
            const socket = connect();

            assert.equal(socket.isAlive, true);
            assert.equal(socket.isLive, true);
            assert.equal(socket.lastHeardAt, time);
        });

        test('messages and closes reach the hooks', () => {
            const received = [];
            const socket = connect({
                onMessage: (raw) => received.push(raw),
                onClose: () => received.push('closed'),
            });

            socket.emit('message', 'hello');
            socket.emit('close');

            assert.deepEqual(received, ['hello', 'closed']);
        });

        test('a hook that throws is logged with its label, not rethrown', () => {
            const socket = connect({
                onMessage: () => {
                    throw new Error('bad message');
                },
                onClose: () => {
                    throw new Error('bad close');
                },
            });

            socket.emit('message', 'x');
            socket.emit('close');

            assert.deepEqual(logger.calls.map((call) => [call[0], call[1]]), [
                ['error', 'Realtime message failed'],
                ['error', 'Realtime close failed'],
            ]);
        });

        test('a pong makes the socket alive again and a socket error is only logged', () => {
            const socket = connect();
            socket.isAlive = false;

            socket.emit('pong');
            socket.emit('error', new Error('reset'));

            assert.equal(socket.isAlive, true);
            assert.deepEqual(logger.calls, [['warn', 'Realtime socket error: reset']]);
        });
    });

    describe('send', () => {
        test('serialises objects and passes text through', () => {
            const socket = connect();

            connections.send(socket, { type: 'pong' });
            connections.send(socket, '{"already":"text"}');

            assert.deepEqual(socket.sent, ['{"type":"pong"}', '{"already":"text"}']);
        });

        test('skips a socket that is no longer open', () => {
            const socket = connect();
            socket.readyState = WebSocket.CLOSING;

            connections.send(socket, { type: 'pong' });

            assert.deepEqual(socket.sent, []);
        });
    });

    describe('liveness', () => {
        test('markHeard is true only when a stale socket comes back', () => {
            const socket = connect();
            time += 50;

            assert.equal(connections.markHeard(socket), false);
            assert.equal(socket.lastHeardAt, time);

            socket.isLive = false;
            assert.equal(connections.markHeard(socket), true);
            assert.equal(socket.isLive, true);
        });

        test('updateLiveness returns the sockets that went stale or came back', () => {
            const quiet = connect();
            const chatty = connect();
            const stale = connect();
            stale.isLive = false;

            time += LIVE_WINDOW_MS + 1;
            chatty.lastHeardAt = time;
            stale.lastHeardAt = time;

            assert.deepEqual(connections.updateLiveness(), [quiet, stale]);
            assert.equal(quiet.isLive, false);
            assert.equal(stale.isLive, true);
            assert.deepEqual(connections.updateLiveness(), []);
        });

        test('a socket heard exactly LIVE_WINDOW_MS ago is still live', () => {
            const socket = connect();
            time += LIVE_WINDOW_MS;

            assert.deepEqual(connections.updateLiveness(), []);
            assert.equal(socket.isLive, true);
        });
    });

    describe('timers', () => {
        test('the heartbeat pings live sockets and terminates ones that missed a pong', () => {
            mock.timers.enable({ apis: ['setInterval'] });
            const answering = connect();
            const silent = connect();
            connections.startTimers(() => {});

            mock.timers.tick(HEARTBEAT_MS);
            assert.equal(answering.pings, 1);
            assert.equal(silent.pings, 1);

            answering.emit('pong');
            mock.timers.tick(HEARTBEAT_MS);
            assert.equal(answering.pings, 2);
            assert.equal(answering.isTerminated, false);
            assert.equal(silent.isTerminated, true);
            assert.equal(silent.pings, 1);
        });

        test('the periodic check runs guarded', () => {
            mock.timers.enable({ apis: ['setInterval'] });
            let checks = 0;
            connections.startTimers(() => {
                checks += 1;
                throw new Error('check failed');
            });

            mock.timers.tick(LIVENESS_MS * 2);

            assert.equal(checks, 2);
            assert.equal(logger.calls.length, 2);
            assert.equal(logger.calls[0][1], 'Realtime periodic check failed');
        });
    });

    describe('close', () => {
        test('stops the timers, terminates sockets and skips guarded handlers', () => {
            mock.timers.enable({ apis: ['setInterval'] });
            const received = [];
            const socket = connect({ onMessage: (raw) => received.push(raw) });
            let checks = 0;
            connections.startTimers(() => {
                checks += 1;
            });

            connections.close();
            mock.timers.tick(HEARTBEAT_MS);
            socket.emit('message', 'late');

            assert.equal(socket.isTerminated, true);
            assert.equal(socket.pings, 0);
            assert.equal(checks, 0);
            assert.deepEqual(received, []);
        });

        test('works before the timers were started', () => {
            const socket = connect();

            connections.close();

            assert.equal(socket.isTerminated, true);
            assert.equal(connections.isClosed, true);
        });
    });
});

describe('Clock', () => {
    test('reads the injected now each time', () => {
        let time = 5;
        const clock = new Clock(() => time);

        assert.equal(clock.now(), 5);
        time = 9;
        assert.equal(clock.now(), 9);
    });

    test('defaults to Date.now', () => {
        const before = Date.now();
        const now = new Clock().now();

        assert.ok(now >= before && now <= Date.now());
    });
});
