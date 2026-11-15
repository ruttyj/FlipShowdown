import { AiController } from '../http/controllers/AiController.js';
import { ScanService } from '../services/ai/ScanService.js';
import { BaseProvider } from './BaseProvider.js';

// AI card scanning: the ScanService (Gemini client, model catalog and rate limit) and the /api/ai
// router HttpProvider mounts. The `geminiFetch` option replaces fetch for Gemini calls (tests).

export class AiProvider extends BaseProvider {
    register(app) {
        app.register('scanService', () => {
            const config = app.get('config');
            return new ScanService({
                apiKey: config.geminiApiKey,
                defaultModel: config.geminiModel,
                logger: app.get('logger'),
                fetchImpl: app.options.geminiFetch,
                clock: app.get('aiClock'),
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
