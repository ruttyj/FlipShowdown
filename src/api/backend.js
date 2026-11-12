// Client for the self-hosted server: auth, entity reads and subscriptions.
// Interface: see "Frontend client interface" in docs/backend-contract.md.

import { request, onSignedOut } from './httpClient.js';
import { RealtimeConnection, realtimeUrlFor } from './realtime.js';
import { createEntitiesProxy } from './entities.js';
import { createRoomChannel } from './roomChannel.js';

// --- Auth ----------------------------------------------------------------------

function me() {
    return request('GET', '/api/auth/me');
}

async function isAuthenticated() {
    try {
        // An anonymous visitor is an expected 401 here, not an expired session.
        await request('GET', '/api/auth/me', { signedOutEvent: false });
        return true;
    } catch {
        return false;
    }
}

function updateMe(data) {
    return request('PUT', '/api/auth/me', { body: data });
}

function redirectToLogin(fromUrl) {
    const target = fromUrl ?? window.location.href;
    window.location.href = `/login?from_url=${encodeURIComponent(target)}`;
}

/** Ends the session, then goes to the server's logout URL, else `redirectUrl`, else reloads. */
async function logout(redirectUrl) {
    let logoutUrl = null;
    try {
        const result = await request('POST', '/api/auth/logout');
        logoutUrl = result?.logout_url ?? null;
    } catch (error) {
        console.error('Logout request failed:', error);
    }

    const destination = logoutUrl ?? redirectUrl;
    if (destination) {
        window.location.href = destination;
    } else {
        window.location.reload();
    }
}

// --- Client ----------------------------------------------------------------------

/** The shared realtime client: rooms, readiness, status, presence, votes and entry status. */
export const realtime = new RealtimeConnection({
    url: realtimeUrlFor(window.location),
    WebSocketImpl: window.WebSocket,
    environment: { window, document, navigator },
    fetchImpl: window.fetch.bind(window),
    // Only used on `resync` when no page has registered an onResync listener to refetch.
    reload: () => window.location.reload(),
});

/** A room's realtime traffic in the game's terms, and its recovery after a reconnect. */
export const roomChannel = createRoomChannel(realtime);

// An expired session found by any HTTP request also stops realtime retries.
onSignedOut(() => realtime.signOut());

export const backend = {
    auth: { me, isAuthenticated, updateMe, redirectToLogin, logout },
    entities: createEntitiesProxy(realtime),
};
