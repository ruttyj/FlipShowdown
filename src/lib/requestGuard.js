// Tells a slow async task whether its result is still wanted. Each `begin()` starts a new
// task and makes earlier ones stale; `invalidate()` makes every running task stale (the
// player went back, retook the photo, or the screen unmounted).

/**
 * @returns {{ begin: () => (() => boolean), invalidate: () => void }}
 *   `begin()` returns `isCurrent()`, true until another `begin()` or an `invalidate()`.
 */
export function createRequestGuard() {
    let generation = 0;

    function begin() {
        generation += 1;
        const mine = generation;
        return () => generation === mine;
    }

    function invalidate() {
        generation += 1;
    }

    return { begin, invalidate };
}
