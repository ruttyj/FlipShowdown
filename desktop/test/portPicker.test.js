import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { PREFERRED_PORT, pickPort, isPortFree, findFreePort } from '../src/main/portPicker.js';

// Tests that touch real sockets bind loopback only, so nothing is reachable from outside.
const LOOPBACK = '127.0.0.1';

function listenOnEphemeralPort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, LOOPBACK, () => {
            resolve(server);
        });
    });
}

function closeServer(server) {
    return new Promise((resolve) => {
        server.close(() => {
            resolve();
        });
    });
}

// --- pickPort with injected probes ---

test('the preferred port is 7007 (decision 13)', () => {
    assert.equal(PREFERRED_PORT, 7007);
});

test('pickPort returns 7007 when it is free', async () => {
    const probed = [];
    const port = await pickPort({
        isPortFree: async (candidate) => {
            probed.push(candidate);
            return true;
        },
        findFreePort: async () => {
            throw new Error('should not be asked for a fallback');
        },
    });

    assert.equal(port, 7007);
    assert.deepEqual(probed, [7007]);
});

test('pickPort falls back to a free port when 7007 is taken', async () => {
    const port = await pickPort({
        isPortFree: async () => false,
        findFreePort: async () => 51234,
    });

    assert.equal(port, 51234);
});

test('pickPort honours a different preferred port', async () => {
    const port = await pickPort({
        preferredPort: 8123,
        isPortFree: async (candidate) => candidate === 8123,
        findFreePort: async () => 1,
    });

    assert.equal(port, 8123);
});

test('pickPort passes the host to both probes', async () => {
    const hosts = [];
    await pickPort({
        host: LOOPBACK,
        isPortFree: async (_port, host) => {
            hosts.push(host);
            return false;
        },
        findFreePort: async (host) => {
            hosts.push(host);
            return 40000;
        },
    });

    assert.deepEqual(hosts, [LOOPBACK, LOOPBACK]);
});

test('pickPort propagates a failure to find any free port', async () => {
    await assert.rejects(
        pickPort({
            isPortFree: async () => false,
            findFreePort: async () => {
                throw new Error('no ports left');
            },
        }),
        /no ports left/,
    );
});

// --- Real loopback probes ---

test('isPortFree is false for a port in use and true once it is released', async () => {
    const server = await listenOnEphemeralPort();
    const { port } = /** @type {net.AddressInfo} */ (server.address());

    assert.equal(await isPortFree(port, LOOPBACK), false);

    await closeServer(server);
    assert.equal(await isPortFree(port, LOOPBACK), true);
});

test('findFreePort returns a port that can then be bound', async () => {
    const port = await findFreePort(LOOPBACK);

    assert.ok(Number.isInteger(port) && port > 0 && port < 65536, `bad port ${port}`);
    assert.equal(await isPortFree(port, LOOPBACK), true);
});

test('pickPort with the real probes skips a busy preferred port', async () => {
    const server = await listenOnEphemeralPort();
    const { port: busyPort } = /** @type {net.AddressInfo} */ (server.address());

    try {
        const port = await pickPort({ preferredPort: busyPort, host: LOOPBACK });
        assert.notEqual(port, busyPort);
        assert.ok(port > 0);
    } finally {
        await closeServer(server);
    }
});

// --- Loopback-only listeners (Docker on Windows) ---
// Another process can hold 127.0.0.1:<port> while a wildcard bind of the same port still
// succeeds, so the default probe must check loopback too: the launcher's health check and
// tunnel both dial 127.0.0.1.

test('isPortFree with no host is false while the port is held on 127.0.0.1 only', async () => {
    const server = await listenOnEphemeralPort();
    const { port } = /** @type {net.AddressInfo} */ (server.address());

    try {
        assert.equal(await isPortFree(port), false);
    } finally {
        await closeServer(server);
    }
});

test('pickPort with the default probes skips a port held on 127.0.0.1 only', async () => {
    const server = await listenOnEphemeralPort();
    const { port: busyPort } = /** @type {net.AddressInfo} */ (server.address());

    try {
        const port = await pickPort({ preferredPort: busyPort });
        assert.notEqual(port, busyPort);
        assert.equal(await isPortFree(port), true);
    } finally {
        await closeServer(server);
    }
});

test('isPortFree with no host is false while the port is held on ::1 only', async (context) => {
    const server = net.createServer();
    const isListening = await new Promise((resolve) => {
        server.once('error', () => {
            resolve(false);
        });
        server.listen(0, '::1', () => {
            resolve(true);
        });
    });
    if (!isListening) {
        context.skip('no IPv6 loopback on this machine');
        return;
    }
    const { port } = /** @type {net.AddressInfo} */ (server.address());

    try {
        assert.equal(await isPortFree(port), false);
    } finally {
        await closeServer(server);
    }
});

test('findFreePort with no host returns a port free on every interface and loopback', async () => {
    const port = await findFreePort();

    assert.ok(Number.isInteger(port) && port > 0 && port < 65536, `bad port ${port}`);
    assert.equal(await isPortFree(port), true);
    assert.equal(await isPortFree(port, LOOPBACK), true);
});

// --- Bind outcomes real sockets can't force ---
// portPicker calls net.createServer at probe time, so mocking it swaps in fake servers whose
// bind result is decided per host. `bindError(port, host)` returns the error a bind should
// fail with, or null for success; an ephemeral bind (port 0) reports FAKE_EPHEMERAL_PORT.

const FAKE_EPHEMERAL_PORT = 45678;

function errorWithCode(code) {
    /** @type {NodeJS.ErrnoException} */
    const error = new Error(code);
    if (code !== undefined) {
        error.code = code;
    }
    return error;
}

function createFakeServer(bindError) {
    /** @type {(error: Error) => void} */
    let onError = () => {};
    let boundPort = 0;
    return {
        once(_event, handler) {
            onError = handler;
        },
        listen(port, host, onListening) {
            boundPort = port === 0 ? FAKE_EPHEMERAL_PORT : port;
            const error = bindError(port, host);
            setImmediate(() => {
                if (error) {
                    onError(error);
                    return;
                }
                onListening();
            });
        },
        address() {
            return { port: boundPort };
        },
        close(onClosed) {
            setImmediate(onClosed);
        },
    };
}

function mockBinds(context, bindError) {
    context.mock.method(net, 'createServer', () => createFakeServer(bindError));
}

for (const code of ['EADDRNOTAVAIL', 'EAFNOSUPPORT']) {
    test(`isPortFree with no host skips a missing IPv6 loopback (${code})`, async (context) => {
        mockBinds(context, (_port, host) => {
            if (host === '::1') {
                return errorWithCode(code);
            }
            return null;
        });

        assert.equal(await isPortFree(7007), true);
    });
}

test('isPortFree counts a bind error without a code as taken', async (context) => {
    mockBinds(context, (_port, host) => {
        if (host === LOOPBACK) {
            return errorWithCode(undefined);
        }
        return null;
    });

    assert.equal(await isPortFree(7007), false);
});

test('findFreePort with no host retries until a port is also free on loopback', async (context) => {
    let loopbackBinds = 0;
    mockBinds(context, (_port, host) => {
        if (host !== LOOPBACK) {
            return null;
        }
        loopbackBinds += 1;
        if (loopbackBinds < 3) {
            return errorWithCode('EADDRINUSE');
        }
        return null;
    });

    assert.equal(await findFreePort(), FAKE_EPHEMERAL_PORT);
    assert.equal(loopbackBinds, 3);
});

test('findFreePort with no host gives up after 20 ports busy on loopback', async (context) => {
    let loopbackBinds = 0;
    mockBinds(context, (_port, host) => {
        if (host === LOOPBACK) {
            loopbackBinds += 1;
            return errorWithCode('EADDRINUSE');
        }
        return null;
    });

    await assert.rejects(findFreePort(), /after 20 tries/);
    assert.equal(loopbackBinds, 20);
});

test('isPortFree with no host is false when the wildcard bind fails', async (context) => {
    mockBinds(context, (_port, host) => {
        if (host === undefined) {
            return errorWithCode('EADDRINUSE');
        }
        return null;
    });

    assert.equal(await isPortFree(7007), false);
});
