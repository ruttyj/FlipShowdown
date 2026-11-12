// Order of the AI models offered for card scanning.

/**
 * Puts the player's chosen model first, keeping the server's order for the rest.
 * models: [{ id, display_name }] from /api/ai/config. A chosen id the server
 * doesn't offer (e.g. a stale localStorage value) is ignored. Returns a new list (or the
 * same one when nothing moves); the input is never changed.
 */
export function orderModelList(models, chosenModelId) {
    const chosen = models.find((model) => model.id === chosenModelId);
    if (!chosen) {
        return models;
    }
    return [chosen, ...models.filter((model) => model !== chosen)];
}
