import { createAiRouter } from '../http/aiRoutes.js';
import { BaseProvider } from './BaseProvider.js';

// AI card scanning: the /api/ai router with its Gemini client, model catalog and rate limit. The
// `geminiFetch` option replaces fetch for Gemini calls (tests).

export class AiProvider extends BaseProvider {
    register(app) {
        app.register('aiRouter', () => {
            const clock = app.get('aiClock');
            return createAiRouter({
                config: app.get('config'),
                logger: app.get('logger'),
                fetchImpl: app.options.geminiFetch,
                now: () => clock.now(),
            });
        });
    }
}
