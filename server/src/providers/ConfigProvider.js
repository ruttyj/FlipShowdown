import { Clock } from '../domain/clock.js';
import { BaseProvider } from './BaseProvider.js';

// The settings every area reads: the loaded config, the logger and the clocks. Each clock is
// Date.now unless createServer's options give a test clock for that area.

export class ConfigProvider extends BaseProvider {
    register(app) {
        app.register('config', () => {
            return app.config;
        });
        app.register('logger', () => {
            return app.options.logger || console;
        });
        // AI model caches and the scan rate limit (option `now`).
        app.register('aiClock', () => {
            return new Clock(app.options.now);
        });
        // Presence liveness, vote countdowns and entry status windows (option `realtimeNow`).
        app.register('realtimeClock', () => {
            return new Clock(app.options.realtimeNow);
        });
        // The stale-room sweep (option `roomSweepNow`).
        app.register('roomSweepClock', () => {
            return new Clock(app.options.roomSweepNow);
        });
    }
}
