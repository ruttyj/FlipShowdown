// AI card scanning through our own server (/api/ai). The server holds the
// Gemini key; the browser only sends photos and gets card lists back.

import { request } from './httpClient.js';

/**
 * Resolves with { enabled, default_model, models: [{ id, display_name }] }.
 * `models` lists the default model first.
 */
export function getAiConfig() {
    return request('GET', '/api/ai/config');
}

/**
 * Sends a photo (data URL) to be read and resolves with
 * { cards: [{ value, type }], model }. Rejects with an Error carrying `status`
 * (502 means the model failed and another one may work) and the server's message.
 * `mode` is the room's `scanMode` from the rules registry, which decides the prompt.
 */
export function scanCards(imageDataUrl, model, mode) {
    return request('POST', '/api/ai/scan-cards', { body: { image: imageDataUrl, model, mode } });
}
