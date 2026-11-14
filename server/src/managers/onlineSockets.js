// Who is online: the one rule behind the presence message and the launcher's player count (X66). A
// socket makes its user online in a room while its page is live (ConnectionManager#isLive) and it
// named the room itself (SubscriptionManager#isExplicitlySubscribed). An admin "*" socket is
// watching, not playing, so it makes nobody online.
//
// Each function takes `managers`, { connections, subscriptions }: the ConnectionManager and the
// SubscriptionManager whose sockets are read.

/** Whether the socket makes its user online in the room. */
function isOnlineIn(managers, socket, roomId) {
    return managers.subscriptions.isExplicitlySubscribed(socket, roomId)
        && managers.connections.isLive(socket);
}

/** Whether the socket makes its user online in any room it named. */
function isOnlineAnywhere(managers, socket) {
    for (const roomId of managers.subscriptions.roomsOf(socket)) {
        if (isOnlineIn(managers, socket, roomId)) {
            return true;
        }
    }
    return false;
}

/** The emails with a socket that makes them online in the room. */
export function onlineEmailsIn(managers, roomId) {
    const emails = new Set();
    for (const socket of managers.connections.clients) {
        if (isOnlineIn(managers, socket, roomId)) {
            emails.add(socket.identity.email);
        }
    }
    return emails;
}

/**
 * How many people are online in at least one room. People, not tabs: one email with a phone and a
 * laptop open counts once.
 */
export function countPeopleOnline(managers) {
    const emails = new Set();
    for (const socket of managers.connections.clients) {
        if (isOnlineAnywhere(managers, socket)) {
            emails.add(socket.identity.email);
        }
    }
    return emails.size;
}
