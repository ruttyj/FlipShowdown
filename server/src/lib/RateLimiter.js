// A sliding-window rate limit per key: at most `limit` hits in any `windowMs`.

export class RateLimiter {
    /** `now()` returns the current time in ms. */
    constructor({ limit, windowMs, now }) {
        this.limit = limit;
        this.windowMs = windowMs;
        this.now = now;
        this.hitsByKey = new Map();
    }

    /** Records a hit for `key` and returns true, or returns false when `key` is over the limit. */
    tryConsume(key) {
        const windowStart = this.now() - this.windowMs;
        const recentHits = (this.hitsByKey.get(key) || []).filter((time) => time > windowStart);

        if (recentHits.length >= this.limit) {
            this.hitsByKey.set(key, recentHits);
            return false;
        }

        recentHits.push(this.now());
        this.hitsByKey.set(key, recentHits);
        return true;
    }
}
