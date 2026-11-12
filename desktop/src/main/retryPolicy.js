// Pure retry policy for the quick tunnel (decision 14): when cloudflared dies, restart it up to
// three times with a growing delay, then give up so the UI shows an error with a Retry button.
// Every restart issues a new trycloudflare URL, so didUrlChange tells the session when to show
// the "URL changed, rescan" banner.
//
// The functions take the current time instead of reading a clock, so the caller (hostingSession)
// owns timers and tests need no fakes.

// --- Policy --------------------------------------------------------------------

/**
 * @typedef {object} RetryPolicy
 * @property {number} maxRetries     Restarts allowed in a row before giving up.
 * @property {number} baseDelayMs    Delay before the first restart.
 * @property {number} backoffFactor  Each further restart waits this many times longer.
 * @property {number} maxDelayMs     Upper bound on any single delay.
 * @property {number} stableAfterMs  A tunnel that stayed connected this long has recovered, so its
 *                                   next failure starts the count afresh instead of using up the
 *                                   retries left over from earlier, unrelated drops.
 */

/** @type {Readonly<RetryPolicy>} */
export const DEFAULT_RETRY_POLICY = Object.freeze({
    maxRetries: 3,
    baseDelayMs: 1000,
    backoffFactor: 2,
    maxDelayMs: 10_000,
    stableAfterMs: 60_000,
});

/**
 * @typedef {object} RetryState
 * @property {number} failureCount       Failures in a row since the tunnel was last stable.
 * @property {number | null} connectedAt When the current connection registered, or null while down.
 */

/**
 * @typedef {{ type: 'retry', attempt: number, delayMs: number } | { type: 'give-up', failures: number }} RetryDecision
 */

// --- State transitions ---------------------------------------------------------

/**
 * The state for a fresh session, and after the user presses Retry following a give-up.
 * @returns {RetryState}
 */
export function initialRetryState() {
    return { failureCount: 0, connectedAt: null };
}

/**
 * Records that the tunnel registered a connection. The failure count is kept until the
 * connection proves stable, so a tunnel that dies seconds after each start still gives up.
 * @param {RetryState} state
 * @param {number} nowMs
 * @returns {RetryState}
 */
export function recordConnected(state, nowMs) {
    return { failureCount: state.failureCount, connectedAt: nowMs };
}

/**
 * Records that the tunnel exited or failed to start, and decides what to do next.
 * @param {RetryState} state
 * @param {number} nowMs
 * @param {RetryPolicy} [policy]
 * @returns {{ state: RetryState, decision: RetryDecision }}
 */
export function recordFailure(state, nowMs, policy = DEFAULT_RETRY_POLICY) {
    const failureCount = failuresBefore(state, nowMs, policy) + 1;
    const nextState = { failureCount, connectedAt: null };

    if (failureCount > policy.maxRetries) {
        return { state: nextState, decision: { type: 'give-up', failures: failureCount } };
    }

    const decision = { type: 'retry', attempt: failureCount, delayMs: retryDelayMs(failureCount, policy) };
    return { state: nextState, decision: /** @type {RetryDecision} */ (decision) };
}

/**
 * @param {RetryState} state
 * @param {number} nowMs
 * @param {RetryPolicy} policy
 */
function failuresBefore(state, nowMs, policy) {
    const wasStable = state.connectedAt !== null
        && nowMs - state.connectedAt >= policy.stableAfterMs;
    if (wasStable) {
        return 0;
    }
    return state.failureCount;
}

/**
 * The wait before restart number `attempt` (1-based): base, base*factor, base*factor^2, ...
 * capped at maxDelayMs.
 * @param {number} attempt
 * @param {RetryPolicy} [policy]
 * @returns {number}
 */
export function retryDelayMs(attempt, policy = DEFAULT_RETRY_POLICY) {
    const delay = policy.baseDelayMs * policy.backoffFactor ** (attempt - 1);
    return Math.min(delay, policy.maxDelayMs);
}

// --- URL change ----------------------------------------------------------------

/**
 * True when a restarted tunnel came up on a different URL than the one players scanned, which
 * is when the session should emit its "URL changed" event and show the rescan banner. The first
 * URL of a session is not a change, and neither is a tunnel that is down (no URL yet).
 * @param {string | null} previousUrl
 * @param {string | null} nextUrl
 * @returns {boolean}
 */
export function didUrlChange(previousUrl, nextUrl) {
    if (previousUrl === null || nextUrl === null) {
        return false;
    }
    return previousUrl !== nextUrl;
}
