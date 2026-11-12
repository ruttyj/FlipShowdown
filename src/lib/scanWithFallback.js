// Model fallback for the AI card scan.

// The server answers 502 when a model failed upstream (unavailable, timed out,
// unreadable answer), so another model may succeed. Bad photos (400), rate
// limits (429) and AI being off (503) would fail the same way on every model.
export const RETRYABLE_SCAN_STATUSES = [502];

/**
 * Tries each model in order until one reads the photo. Moves on only after
 * errors another model could plausibly avoid; otherwise rethrows at once.
 * Resolves with the server's { cards, model }.
 *
 * `scanCards(imageDataUrl, modelId, scanMode)` and `toast` (with `.warning`) are
 * passed in so the fallback logic can be tested without the network or the UI.
 * `scanMode` is what every model is asked to read the photo as.
 */
export async function scanWithFallback(imageDataUrl, modelList, { scanCards, toast, scanMode }) {
    let lastError = new Error('No AI models are available');

    for (let index = 0; index < modelList.length; index++) {
        const model = modelList[index];
        try {
            return await scanCards(imageDataUrl, model.id, scanMode);
        } catch (error) {
            console.error(`${model.id} analysis error:`, error);
            lastError = error;

            const hasMoreModels = index < modelList.length - 1;
            const isRetryable = RETRYABLE_SCAN_STATUSES.includes(error.status);
            if (!hasMoreModels || !isRetryable) {
                break;
            }
            toast.warning(`${model.display_name} failed, trying next model...`);
        }
    }

    throw lastError;
}
