import { LauncherReporter } from '../managers/LauncherReporter.js';
import { BaseProvider } from './BaseProvider.js';

// Room stats for the desktop launcher (X66). The `launcherPort` option replaces Electron's
// process.parentPort (tests pass a fake or null) and `launcherReportDelayMs` the coalescing delay.

export class LauncherProvider extends BaseProvider {
    register(app) {
        app.register('launcherReporter', () => {
            const hub = app.get('hub');
            return new LauncherReporter({
                // undefined means Electron's process.parentPort.
                parentPort: app.options.launcherPort,
                buildStats: () => hub.buildRoomStats(),
                delayMs: app.options.launcherReportDelayMs,
                logger: app.get('logger'),
                onStatsChanged: (listener) => hub.onStatsChanged(listener),
            });
        });
    }

    boot(app) {
        const reporter = app.get('launcherReporter');
        // The launcher shows 0 / 0 as soon as the server is up, not after the first change (X66).
        app.get('httpServer').on('listening', () => reporter.sendNow());
    }

    shutdown(app) {
        app.get('launcherReporter').close();
    }
}
