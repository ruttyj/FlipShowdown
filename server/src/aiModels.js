// Which Gemini models the app offers for card scanning, and a cache of that list.

const CACHE_TTL_MS = 60 * 60 * 1000;
// After a failed list call, offer only the default for a short while, then retry.
const FAILURE_TTL_MS = 60 * 1000;

// Gemini models that can't do image -> text generateContent (speech, live audio,
// image/video generation, embeddings, agents for other surfaces).
// Examples: "gemini-3.8-flash-tts", "gemini-3.1-flash-image", "gemini-embedding-001".
const UNSUITABLE_MODEL_PATTERN = /embedding|tts|audio|live|image|transcribe|translate|omni|computer-use|robotics|aqa/;

// "gemini-3.8-flash" -> 3.8, "gemma-4-31b-it" -> 4, "gemini-flash-latest" -> no match.
const VERSION_PATTERN = /^(?:gemini|gemma)-(\d+(?:\.\d+)?)/;

// Gemma models that accept images: Gemma 4 and later, and the larger Gemma 3 sizes.
// The 1B Gemma 3, Gemma 3n and Gemma 2 are text-only on the API.
// Examples: "gemma-4-26b-a4b-it" and "gemma-3-27b-it" match; "gemma-3-1b-it" doesn't.
const VISION_GEMMA_PATTERN = /^gemma-(?:[4-9]|\d{2,}|3-(?:4b|12b|27b))-/;

// --- Filtering -----------------------------------------------------------

function modelId(model) {
    return String(model.name || '').replace(/^models\//, '');
}

function isGemma(id) {
    return id.startsWith('gemma-');
}

function isUsableForScanning(model) {
    const id = modelId(model);
    const methods = Array.isArray(model.supportedGenerationMethods) ? model.supportedGenerationMethods : [];
    const isScanningFamily = id.startsWith('gemini-') || VISION_GEMMA_PATTERN.test(id);

    return isScanningFamily
        && methods.includes('generateContent')
        && !UNSUITABLE_MODEL_PATTERN.test(id);
}

/**
 * Whether the model can be held to a JSON schema (structured output). Google
 * doesn't document that for Gemma, so Gemma gets the format in the prompt instead.
 */
export function supportsStructuredOutput(id) {
    return !isGemma(id);
}

// --- Ordering ------------------------------------------------------------

function modelVersion(id) {
    const match = VERSION_PATTERN.exec(id);
    if (!match) {
        return 0;
    }
    return Number(match[1]);
}

/** Flash first (fast, cheap, good at reading cards), then Flash-Lite, Pro, anything else. */
function modelTierRank(id) {
    if (id.includes('flash-lite')) {
        return 1;
    }
    if (id.includes('flash')) {
        return 0;
    }
    if (id.includes('pro')) {
        return 2;
    }
    return 3;
}

function isPreview(id) {
    return /preview|exp/.test(id);
}

/**
 * Gemini before Gemma, then newest version first; within a version
 * Flash > Flash-Lite > Pro, stable before preview.
 */
function compareModels(a, b) {
    const familyDifference = Number(isGemma(a.id)) - Number(isGemma(b.id));
    if (familyDifference !== 0) {
        return familyDifference;
    }

    const versionDifference = modelVersion(b.id) - modelVersion(a.id);
    if (versionDifference !== 0) {
        return versionDifference;
    }

    const tierDifference = modelTierRank(a.id) - modelTierRank(b.id);
    if (tierDifference !== 0) {
        return tierDifference;
    }

    const previewDifference = Number(isPreview(a.id)) - Number(isPreview(b.id));
    if (previewDifference !== 0) {
        return previewDifference;
    }

    return a.id.localeCompare(b.id);
}

/**
 * Turns raw Model resources into the offered list: [{ id, display_name }], the
 * default model first. The default is offered even when the list lacks it,
 * since the list can be incomplete; a scan with a bad id fails and the client
 * moves on to the next model.
 */
export function selectScanningModels(rawModels, defaultModel) {
    const offered = [];
    const seen = new Set();

    for (const model of rawModels) {
        const id = modelId(model);
        if (!isUsableForScanning(model) || seen.has(id)) {
            continue;
        }
        seen.add(id);
        offered.push({ id, display_name: model.displayName || id });
    }

    offered.sort(compareModels);

    let defaultEntry = offered.find((model) => model.id === defaultModel);
    if (!defaultEntry) {
        defaultEntry = { id: defaultModel, display_name: defaultModel };
    }

    const others = offered.filter((model) => model.id !== defaultModel);
    return [defaultEntry, ...others];
}

// --- Cache ---------------------------------------------------------------

async function loadModels(state) {
    try {
        const rawModels = await state.client.listModels();
        state.models = selectScanningModels(rawModels, state.defaultModel);
        state.expiresAt = state.now() + CACHE_TTL_MS;
    } catch (error) {
        state.logger.warn(`Could not list Gemini models, offering only ${state.defaultModel}: ${error.detail || error.message}`);
        state.models = selectScanningModels([], state.defaultModel);
        state.expiresAt = state.now() + FAILURE_TTL_MS;
    }
    return state.models;
}

/**
 * Returns { getModels() } resolving to the offered model list. The list is
 * cached for an hour; a failed list call falls back to just the default model
 * (cached briefly) instead of rejecting. Concurrent callers share one fetch.
 */
export function createModelCatalog({ client, defaultModel, logger, now = Date.now }) {
    const state = { client, defaultModel, logger, now, models: null, expiresAt: 0, pending: null };

    return {
        getModels() {
            const isFresh = state.models && state.now() < state.expiresAt;
            if (isFresh) {
                return Promise.resolve(state.models);
            }

            if (!state.pending) {
                state.pending = loadModels(state).finally(() => {
                    state.pending = null;
                });
            }
            return state.pending;
        },
    };
}
