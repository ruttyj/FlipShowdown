import { RateLimiter } from '../../lib/RateLimiter.js';
import { createModelCatalog } from './aiModels.js';
import { GeminiError, createGeminiClient } from './gemini.js';
import { buildScanRequest, getScanMode, normaliseScanResult } from './scanModes.js';

// AI card scanning: the models on offer, the per-user scan rate limit, and reading the cards in a
// photo through Gemini. The Gemini key stays on the server: browsers only ever see model ids and
// card lists.

// A ~4 MB image is ~5.4 MB as base64, plus the JSON wrapper (the route's body limit allows for it).
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// Anyone who can open the public URL can sign in, so cap how fast one user can spend quota.
const SCANS_PER_WINDOW = 20;
const RATE_WINDOW_MS = 60 * 1000;

// --- Image data URLs -----------------------------------------------------

// "data:image/jpeg;base64,/9j/4AAQ..." -> mime "image/jpeg", base64 "/9j/4AAQ..."
const IMAGE_DATA_URL_PATTERN = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

function decodedBase64Size(base64) {
    let padding = 0;
    if (base64.endsWith('==')) {
        padding = 2;
    } else if (base64.endsWith('=')) {
        padding = 1;
    }
    return (base64.length / 4) * 3 - padding;
}

/** Returns { image: { mimeType, base64 } } or { error: message }. */
function parseImageDataUrl(value) {
    if (typeof value !== 'string') {
        return { error: 'image must be a data URL string' };
    }

    const match = IMAGE_DATA_URL_PATTERN.exec(value);
    if (!match || match[2].length % 4 !== 0) {
        return { error: 'image must be a base64 data URL of a JPEG, PNG or WebP image' };
    }

    if (decodedBase64Size(match[2]) > MAX_IMAGE_BYTES) {
        return { error: 'image is too large (max 4 MB)' };
    }
    return { image: { mimeType: match[1], base64: match[2] } };
}

// --- Results -------------------------------------------------------------

/**
 * What a scan can end in (the `outcome` of its result). The controller turns each into a status.
 * SCANNED carries { cards, model }; the others carry the { message } the user sees.
 */
export const ScanOutcome = Object.freeze({
    SCANNED: 'scanned',
    // The image or the model asked for is not acceptable.
    INVALID_REQUEST: 'invalid_request',
    // Gemini is rate-limiting the server's key.
    AI_BUSY: 'ai_busy',
    // Gemini failed or gave an answer we can't read.
    AI_FAILED: 'ai_failed',
});

function failure(outcome, message) {
    return { outcome, message };
}

/** Maps a Gemini failure to the result the client sees. */
function describeGeminiFailure(error) {
    if (error.status === 429) {
        return failure(
            ScanOutcome.AI_BUSY,
            'The AI service is busy right now. Wait a minute and try again, or enter the score manually.',
        );
    }
    if (error.status === 504) {
        return failure(ScanOutcome.AI_FAILED, 'The AI model took too long to answer. Try again.');
    }
    return failure(ScanOutcome.AI_FAILED, 'The AI model could not read this photo. Try again or pick another model.');
}

// --- Service -------------------------------------------------------------

export class ScanService {
    /**
     * Scanning is disabled (config says enabled: false) when `apiKey` is empty. `defaultModel` is
     * the GEMINI_MODEL setting, `fetchImpl` replaces fetch for Gemini calls (tests) and `clock`
     * times the model cache and the rate limit.
     */
    constructor({ apiKey, defaultModel, logger, fetchImpl, clock }) {
        const now = () => clock.now();
        this.defaultModel = defaultModel;
        this.logger = logger;
        this.limiter = new RateLimiter({ limit: SCANS_PER_WINDOW, windowMs: RATE_WINDOW_MS, now });
        this.client = null;
        this.catalog = null;

        if (apiKey) {
            this.client = createGeminiClient({ apiKey, fetchImpl });
            this.catalog = createModelCatalog({ client: this.client, defaultModel, logger, now });
        }
    }

    isEnabled() {
        return this.client !== null;
    }

    /** The /api/ai/config answer: { enabled, default_model, models }. */
    async getConfig() {
        if (!this.isEnabled()) {
            return { enabled: false, default_model: null, models: [] };
        }

        const models = await this.catalog.getModels();
        return { enabled: true, default_model: this.defaultModel, models };
    }

    /** Counts a scan against the user's rate limit; false when they are over it. */
    tryStartScan(email) {
        return this.limiter.tryConsume(email);
    }

    /** The model id to use, or null when the client asked for one we don't offer. */
    async #resolveModel(requested) {
        if (requested === undefined || requested === null || requested === '') {
            return this.defaultModel;
        }

        const models = await this.catalog.getModels();
        const isOffered = models.some((model) => model.id === requested);
        if (!isOffered) {
            return null;
        }
        return requested;
    }

    /**
     * Reads the cards in a photo. `request` is the scan body ({ image, model?, mode? }, an object).
     * Resolves to { outcome: SCANNED, cards, model } or { outcome, message } for a failure (see
     * ScanOutcome). Throws when scanning is disabled, and for anything but a Gemini failure.
     */
    async scan(request) {
        if (!this.isEnabled()) {
            throw new Error('AI card scanning is disabled; check isEnabled() before scanning');
        }

        const parsedImage = parseImageDataUrl(request.image);
        if (parsedImage.error) {
            return failure(ScanOutcome.INVALID_REQUEST, parsedImage.error);
        }

        const model = await this.#resolveModel(request.model);
        if (!model) {
            return failure(ScanOutcome.INVALID_REQUEST, 'Unknown model');
        }

        const scanMode = getScanMode(request.mode);

        let result;
        try {
            result = await this.client.generateJson(buildScanRequest(model, parsedImage.image, scanMode));
        } catch (error) {
            if (!(error instanceof GeminiError)) {
                throw error;
            }
            this.logger.warn(`Gemini scan with ${model} failed (status ${error.status}): ${error.detail}`);
            return describeGeminiFailure(error);
        }

        const cards = normaliseScanResult(result, scanMode);
        if (!cards) {
            this.logger.warn(`Gemini scan with ${model} returned an unexpected shape: ${JSON.stringify(result).slice(0, 500)}`);
            return failure(ScanOutcome.AI_FAILED, 'The AI model gave an unreadable answer. Try again or pick another model.');
        }

        return { outcome: ScanOutcome.SCANNED, cards, model };
    }
}
