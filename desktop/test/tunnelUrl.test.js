import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTunnelUrl, isTunnelReady, createTunnelLogWatcher } from '../src/main/tunnelUrl.js';

// Lines in the shape cloudflared 2025.x prints to stderr for a quick tunnel.
const BANNER_URL_LINE = '2026-11-06T10:00:01Z INF |  https://calm-river-1234.trycloudflare.com                    |';
const READY_LINE = '2026-11-06T10:00:03Z INF Registered tunnel connection connIndex=0 connection=abc event=0 ip=198.41.200.13 location=ams01 protocol=quic';
const API_ERROR_LINE = '2026-11-06T10:00:01Z ERR Error unmarshaling QuickTunnel response: failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup api.trycloudflare.com: no such host';

// --- findTunnelUrl ---

test('findTunnelUrl returns the URL from cloudflared\'s banner line', () => {
    assert.equal(findTunnelUrl(BANNER_URL_LINE), 'https://calm-river-1234.trycloudflare.com');
});

test('findTunnelUrl returns null before the URL has been printed', () => {
    assert.equal(findTunnelUrl('2026-11-06T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...'), null);
    assert.equal(findTunnelUrl(''), null);
});

test('findTunnelUrl ignores the api.trycloudflare.com endpoint quoted in error lines', () => {
    assert.equal(findTunnelUrl(API_ERROR_LINE), null);
});

test('findTunnelUrl finds the tunnel URL after an api endpoint mention in the same text', () => {
    assert.equal(findTunnelUrl(`${API_ERROR_LINE}\n${BANNER_URL_LINE}`), 'https://calm-river-1234.trycloudflare.com');
});

test('findTunnelUrl ignores http (non-TLS) and look-alike hosts', () => {
    assert.equal(findTunnelUrl('http://calm-river.trycloudflare.com'), null);
    assert.equal(findTunnelUrl('https://calm-river.trycloudflare.com.evil.example'), null);
    assert.equal(findTunnelUrl('https://calm-river.nottrycloudflare.com'), null);
});

test('findTunnelUrl returns the first tunnel URL when several are present', () => {
    const text = 'https://first-one.trycloudflare.com and https://second-one.trycloudflare.com';

    assert.equal(findTunnelUrl(text), 'https://first-one.trycloudflare.com');
});

// --- isTunnelReady ---

test('isTunnelReady is true once a tunnel connection is registered', () => {
    assert.equal(isTunnelReady(READY_LINE), true);
});

test('isTunnelReady is false for the URL banner alone', () => {
    assert.equal(isTunnelReady(BANNER_URL_LINE), false);
    assert.equal(isTunnelReady(''), false);
});

// --- createTunnelLogWatcher ---

test('the watcher starts with no URL and not ready', () => {
    const watcher = createTunnelLogWatcher();

    assert.deepEqual(watcher.push(''), { url: null, isReady: false });
});

test('the watcher reports the URL first and readiness later', () => {
    const watcher = createTunnelLogWatcher();

    assert.deepEqual(watcher.push(`${BANNER_URL_LINE}\n`), {
        url: 'https://calm-river-1234.trycloudflare.com',
        isReady: false,
    });
    assert.deepEqual(watcher.push(`${READY_LINE}\n`), {
        url: 'https://calm-river-1234.trycloudflare.com',
        isReady: true,
    });
});

test('the watcher handles a URL split across two output chunks', () => {
    const watcher = createTunnelLogWatcher();

    assert.equal(watcher.push('INF |  https://calm-river-12').url, null);
    assert.equal(watcher.push('34.trycloudflare.com  |\n').url, 'https://calm-river-1234.trycloudflare.com');
});

test('the watcher handles the readiness phrase split across chunks', () => {
    const watcher = createTunnelLogWatcher();

    assert.equal(watcher.push('INF Registered tun').isReady, false);
    assert.equal(watcher.push('nel connection connIndex=0\n').isReady, true);
});

test('the watcher accepts Buffer chunks as a child process stream emits them', () => {
    const watcher = createTunnelLogWatcher();

    const state = watcher.push(Buffer.from(`${BANNER_URL_LINE}\r\n${READY_LINE}\r\n`));

    assert.deepEqual(state, { url: 'https://calm-river-1234.trycloudflare.com', isReady: true });
});

test('the watcher keeps the first URL even if a later line mentions another', () => {
    const watcher = createTunnelLogWatcher();

    watcher.push(`${BANNER_URL_LINE}\n`);
    const state = watcher.push('https://other-name.trycloudflare.com\n');

    assert.equal(state.url, 'https://calm-river-1234.trycloudflare.com');
});

test('the watcher does not take the api endpoint from an error line as the URL', () => {
    const watcher = createTunnelLogWatcher();

    assert.equal(watcher.push(`${API_ERROR_LINE}\n`).url, null);
});

test('the watcher does not grow without bound on a long line with no newline', () => {
    const watcher = createTunnelLogWatcher();

    for (let index = 0; index < 1000; index++) {
        watcher.push('x'.repeat(1000));
    }
    const state = watcher.push(`\n${BANNER_URL_LINE}\n`);

    assert.equal(state.url, 'https://calm-river-1234.trycloudflare.com');
});
