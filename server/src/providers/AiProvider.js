import { AiController } from '../http/controllers/AiController.js';
import { ModelCatalog } from '../services/ai/aiModels.js';
import { GeminiClient } from '../services/ai/gemini.js';
import { createScanRateLimiter, ScanService } from '../services/ai/ScanService.js';
import { BaseProvider } from './BaseProvider.js';

// AI card scanning: the Gemini client, its model catalog, the scan rate limit, the ScanService over
// them and the /api/ai router HttpProvider mounts. The `geminiFetch` option replaces fetch for
// Gemini calls (tests).

/** The AI clock as the `now()` (ms) function the catalog and the rate limiter take. */
function aiNow(app) {
    const clock = app.get('aiClock');
    return () => clock.now();
}

export class AiProvider extends BaseProvider {
    register(app) {
        // Null without a Gemini key, which disables scanning.
        app.register('geminiClient', () => {
            const apiKey = app.get('config').geminiApiKey;
            if (!apiKey) {
                return null;
            }
            return new GeminiClient({ apiKey, fetchImpl: app.options.geminiFetch });
        });
        app.register('modelCatalog', () => {
            const client = app.get('geminiClient');
            if (!client) {
                return null;
            }
            return new ModelCatalog({
                client,
                defaultModel: app.get('config').geminiModel,
                logger: app.get('logger'),
                now: aiNow(app),
            });
        });
        app.register('scanService', () => {
            return new ScanService({
                client: app.get('geminiClient'),
                catalog: app.get('modelCatalog'),
                limiter: createScanRateLimiter(aiNow(app)),
                defaultModel: app.get('config').geminiModel,
                logger: app.get('logger'),
            });
        });
        app.register('aiController', () => {
            return new AiController({ scans: app.get('scanService') });
        });
        app.register('aiRouter', () => {
            return app.get('aiController').router();
        });
    }
}
