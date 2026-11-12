import express from 'express';
import { createModelCatalog } from './aiModels.js';
import { GeminiError, createGeminiClient } from './gemini.js';
import { isPlainObject } from './query.js';
import { buildScanRequest, getScanMode, normaliseScanResult } from './scanModes.js';

// Routes under /api/ai. Mounted after requireUser, so req.user is set.
// The Gemini key stays on the server: browsers only ever see model ids and card lists.

// A ~4 MB image is ~5.4 MB as base64, plus the JSON wrapper.
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const SCAN_BODY_LIMIT = '6mb';

// Anyone who can open the public URL can sign in, so cap how fast one user can spend quota.
const SCANS_PER_WINDOW = 20;
const RATE_WINDOW_MS = 60 * 1000;

// --- Helpers -------------------------------------------------------------

function sendError(res, status, message) {
    res.status(status).json({ message });
}

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

/** Maps a Gemini failure to the { status, message } the client sees. */
function describeGeminiFailure(error) {
    if (error.status === 429) {
        return {
            status: 429,
            message: 'The AI service is busy right now. Wait a minute and try again, or enter the score manually.',
        };
    }
    if (error.status === 504) {
        return { status: 502, message: 'The AI model took too long to answer. Try again.' };
    }
    return { status: 502, message: 'The AI model could not read this photo. Try again or pick another model.' };
}

// --- Rate limiting -------------------------------------------------------

/** Sliding-window limiter keyed by user: tryConsume(key) -> true when allowed. */
function createRateLimiter({ limit, windowMs, now }) {
    const hitsByKey = new Map();

    return {
        tryConsume(key) {
            const windowStart = now() - windowMs;
            const recentHits = (hitsByKey.get(key) || []).filter((time) => time > windowStart);

            if (recentHits.length >= limit) {
                hitsByKey.set(key, recentHits);
                return false;
            }

            recentHits.push(now());
            hitsByKey.set(key, recentHits);
            return true;
        },
    };
}

// --- Handlers ------------------------------------------------------------

async function getConfig(ai, req, res) {
    if (!ai.client) {
        res.json({ enabled: false, default_model: null, models: [] });
        return;
    }

    const models = await ai.catalog.getModels();
    res.json({ enabled: true, default_model: ai.defaultModel, models });
}

function requireAiEnabled(ai, req, res, next) {
    if (!ai.client) {
        sendError(res, 503, 'AI card scanning is not set up on this server');
        return;
    }
    next();
}

function enforceScanRateLimit(ai, req, res, next) {
    if (!ai.limiter.tryConsume(req.user.email)) {
        sendError(res, 429, 'Too many scans. Wait a minute and try again.');
        return;
    }
    next();
}

/** Returns the model id to use, or null when the client asked for one we don't offer. */
async function resolveModel(ai, requested) {
    if (requested === undefined || requested === null || requested === '') {
        return ai.defaultModel;
    }

    const models = await ai.catalog.getModels();
    const isOffered = models.some((model) => model.id === requested);
    if (!isOffered) {
        return null;
    }
    return requested;
}

async function scanCards(ai, req, res) {
    if (!isPlainObject(req.body)) {
        sendError(res, 400, 'Body must be a JSON object with an image data URL');
        return;
    }

    const parsedImage = parseImageDataUrl(req.body.image);
    if (parsedImage.error) {
        sendError(res, 400, parsedImage.error);
        return;
    }

    const model = await resolveModel(ai, req.body.model);
    if (!model) {
        sendError(res, 400, 'Unknown model');
        return;
    }

    const scanMode = getScanMode(req.body.mode);

    let result;
    try {
        result = await ai.client.generateJson(buildScanRequest(model, parsedImage.image, scanMode));
    } catch (error) {
        if (!(error instanceof GeminiError)) {
            throw error;
        }
        ai.logger.warn(`Gemini scan with ${model} failed (status ${error.status}): ${error.detail}`);
        const failure = describeGeminiFailure(error);
        sendError(res, failure.status, failure.message);
        return;
    }

    const cards = normaliseScanResult(result, scanMode);
    if (!cards) {
        ai.logger.warn(`Gemini scan with ${model} returned an unexpected shape: ${JSON.stringify(result).slice(0, 500)}`);
        sendError(res, 502, 'The AI model gave an unreadable answer. Try again or pick another model.');
        return;
    }

    res.json({ cards, model });
}

// --- Router --------------------------------------------------------------

/**
 * options = { config, logger, fetchImpl?, now? }. AI is disabled (config says
 * enabled: false, scans answer 503) when config.geminiApiKey is empty.
 * Must be mounted before the global /api JSON parser, which would reject
 * photo uploads with its smaller body limit.
 */
export function createAiRouter({ config, logger, fetchImpl, now = Date.now }) {
    const ai = {
        client: null,
        catalog: null,
        defaultModel: config.geminiModel,
        logger,
        limiter: createRateLimiter({ limit: SCANS_PER_WINDOW, windowMs: RATE_WINDOW_MS, now }),
    };

    if (config.geminiApiKey) {
        ai.client = createGeminiClient({ apiKey: config.geminiApiKey, fetchImpl });
        ai.catalog = createModelCatalog({ client: ai.client, defaultModel: ai.defaultModel, logger, now });
    }

    const router = express.Router();

    router.get('/config', (req, res) => getConfig(ai, req, res));
    router.post(
        '/scan-cards',
        (req, res, next) => requireAiEnabled(ai, req, res, next),
        // Rate-limit before parsing so a flood of large uploads isn't even read.
        (req, res, next) => enforceScanRateLimit(ai, req, res, next),
        express.json({ limit: SCAN_BODY_LIMIT }),
        (req, res) => scanCards(ai, req, res),
    );

    return router;
}
