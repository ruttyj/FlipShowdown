// A stand-in for the realtime managers the socket edge calls (this file contains no tests of its
// own). Every method call is recorded in order as [part.method, ...args], so a test can check the
// sequence a handler runs; `results` sets what a method returns.

const PART_METHODS = {
    connections: ['send', 'markHeard', 'register'],
    subscriptions: ['register', 'resolve', 'apply', 'isSubscribed', 'roomsOf', 'unsubscribeAll'],
    publisher: ['classifyHello', 'replay'],
    presence: ['refreshRooms', 'sendState'],
    votes: ['dropHolds', 'dropAllHolds', 'hold', 'release', 'sendStates'],
    entries: ['receive', 'sendState'],
    roomStates: ['send'],
};

/**
 * Returns { calls, results, parts }: `parts` holds connections, subscriptions, publisher (with
 * epoch 'e1' and seq 7), presence, votes, entries and roomStates. `results['part.method']` is what
 * that method returns (undefined when unset).
 */
export function createRecordingParts() {
    const calls = [];
    const results = {};
    const parts = {};
    for (const [partName, methods] of Object.entries(PART_METHODS)) {
        const part = {};
        for (const method of methods) {
            const name = `${partName}.${method}`;
            part[method] = (...args) => {
                calls.push([name, ...args]);
                return results[name];
            };
        }
        parts[partName] = part;
    }
    parts.publisher.epoch = 'e1';
    parts.publisher.seq = 7;
    return { calls, results, parts };
}
