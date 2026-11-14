import { AiProvider } from './AiProvider.js';
import { AuthProvider } from './AuthProvider.js';
import { ConfigProvider } from './ConfigProvider.js';
import { DatabaseProvider } from './DatabaseProvider.js';
import { GameProvider } from './GameProvider.js';
import { HttpProvider } from './HttpProvider.js';
import { LauncherProvider } from './LauncherProvider.js';
import { RealtimeProvider } from './RealtimeProvider.js';
import { SchedulerProvider } from './SchedulerProvider.js';

/**
 * The server's providers, in order. Parts are built lazily, so the order doesn't matter for
 * registering; it sets the boot order and, reversed, the shutdown order:
 *   boot     - the launcher's 'listening' listener before the sweep's (as before)
 *   shutdown - stop the sweep, close the launcher reporter, close the realtime hub, close the
 *              HTTP server (waiting for in-flight requests), then close the database
 */
export function createProviders() {
    return [
        new ConfigProvider(),
        new DatabaseProvider(),
        new AuthProvider(),
        new GameProvider(),
        new AiProvider(),
        new HttpProvider(),
        new RealtimeProvider(),
        new LauncherProvider(),
        new SchedulerProvider(),
    ];
}
