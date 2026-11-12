// Dev server only (`npm run dev`, `npm run share`). Vite's client reloads the page whenever
// its HMR WebSocket drops: it awaits the `vite:ws:disconnect` listeners, then calls
// location.reload(). Phones drop that socket as soon as another app takes over, so coming
// back from the camera app reloaded the page and lost the photo (X26).

/**
 * Keeps the page instead: the listener never settles, so Vite never gets to its reload.
 * Hot updates stop until the next manual refresh. `hot` is `import.meta.hot`, which is
 * undefined in a production build.
 */
export function holdReloadOnDisconnect(hot) {
    if (!hot) {
        return;
    }

    hot.on('vite:ws:disconnect', () => {
        console.info('[flip-showdown] Dev server connection lost. Refresh to pick up code changes.');
        return new Promise(() => {});
    });
}
