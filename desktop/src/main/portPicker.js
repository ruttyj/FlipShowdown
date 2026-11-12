// Chooses the port the game server listens on (decision 13): 7007 when free, so a host who
// bookmarked http://localhost:7007 keeps it, otherwise whatever free port the OS hands out.
import net from 'node:net';

export const PREFERRED_PORT = 7007;

// The server listens on all interfaces, but the launcher's health check and tunnel dial
// 127.0.0.1. On Windows another process (Docker's published ports, for one) can hold
// 127.0.0.1:<port> while a wildcard bind of the same port still succeeds, so with no host a
// port only counts as free when the wildcard address and the loopbacks can all be bound.
const IPV4_LOOPBACK = '127.0.0.1';
const IPV6_LOOPBACK = '::1';

// Bind errors meaning the address does not exist on this machine (IPv6 disabled, say), so
// they say nothing about whether the port is taken.
const ADDRESS_UNAVAILABLE_CODES = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);

// How many OS-assigned ports findFreePort tries before giving up on one that is also free
// on loopback.
const FREE_PORT_ATTEMPTS = 20;

// --- Single-address probes -------------------------------------------------------

/**
 * Tries to bind `port` on `host` and releases it straight away.
 * @param {number} port
 * @param {string} [host]  All interfaces when omitted.
 * @returns {Promise<'free' | 'taken' | 'unavailable'>}  'unavailable' when the address
 *   itself does not exist here.
 */
function tryBind(port, host) {
    return new Promise((resolve) => {
        const probe = net.createServer();
        probe.once('error', (error) => {
            const code = /** @type {NodeJS.ErrnoException} */ (error).code ?? '';
            if (ADDRESS_UNAVAILABLE_CODES.has(code)) {
                resolve('unavailable');
                return;
            }
            resolve('taken');
        });
        probe.listen(port, host, () => {
            probe.close(() => {
                resolve('free');
            });
        });
    });
}

/**
 * True when `port` can be bound on the wildcard address and on both loopbacks. A missing
 * IPv6 loopback is skipped rather than counted as taken.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
async function isFreeOnAllInterfacesAndLoopback(port) {
    if ((await tryBind(port)) !== 'free') {
        return false;
    }
    if ((await tryBind(port, IPV4_LOOPBACK)) !== 'free') {
        return false;
    }

    const ipv6LoopbackResult = await tryBind(port, IPV6_LOOPBACK);
    return ipv6LoopbackResult !== 'taken';
}

/**
 * A port the OS reports free on `host`, found by binding port 0 and releasing it.
 * @param {string} [host]  All interfaces when omitted.
 * @returns {Promise<number>}
 */
function askOsForPort(host) {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, host, () => {
            const { port } = /** @type {net.AddressInfo} */ (probe.address());
            probe.close(() => {
                resolve(port);
            });
        });
    });
}

// --- Probes --------------------------------------------------------------------

/**
 * True when `port` can be bound right now. With a host it probes that address only; with
 * none, the wildcard address and the loopbacks must all be free. The answer can go stale
 * before the server binds; the server then fails to start and the session reports it.
 * @param {number} port
 * @param {string} [host]
 * @returns {Promise<boolean>}
 */
export async function isPortFree(port, host) {
    if (host !== undefined) {
        return (await tryBind(port, host)) === 'free';
    }
    return isFreeOnAllInterfacesAndLoopback(port);
}

/**
 * A port the OS reports free. With no host it must also be free on the loopbacks (as
 * isPortFree checks), so OS-assigned ports are retried until one is.
 * @param {string} [host]
 * @returns {Promise<number>}
 */
export async function findFreePort(host) {
    if (host !== undefined) {
        return askOsForPort(host);
    }

    for (let attempt = 0; attempt < FREE_PORT_ATTEMPTS; attempt += 1) {
        const port = await askOsForPort();
        if (await isFreeOnAllInterfacesAndLoopback(port)) {
            return port;
        }
    }
    throw new Error(`No port was free on all interfaces and loopback after ${FREE_PORT_ATTEMPTS} tries`);
}

// --- Choice --------------------------------------------------------------------

/**
 * @typedef {object} PickPortOptions
 * @property {number} [preferredPort]  Defaults to 7007.
 * @property {string} [host]           Interface to probe; all interfaces plus loopback when omitted.
 * @property {(port: number, host?: string) => Promise<boolean>} [isPortFree]  Injectable for tests.
 * @property {(host?: string) => Promise<number>} [findFreePort]               Injectable for tests.
 */

/**
 * The preferred port when it is free, otherwise any free port.
 * @param {PickPortOptions} [options]
 * @returns {Promise<number>}
 */
export async function pickPort(options = {}) {
    const preferredPort = options.preferredPort ?? PREFERRED_PORT;
    const probePort = options.isPortFree ?? isPortFree;
    const askForFreePort = options.findFreePort ?? findFreePort;

    if (await probePort(preferredPort, options.host)) {
        return preferredPort;
    }
    return askForFreePort(options.host);
}
