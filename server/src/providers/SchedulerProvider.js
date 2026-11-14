import { RoomSweepManager } from '../managers/RoomSweepManager.js';
import { BaseProvider } from './BaseProvider.js';

// The timed jobs: the stale-room sweep (X81), which starts once the server is listening.

export class SchedulerProvider extends BaseProvider {
    register(app) {
        app.register('roomSweeper', () => {
            return new RoomSweepManager({
                rooms: app.get('repositories').rooms,
                // The hub, so hasPlayersOnline is read through it at call time.
                presence: app.get('hub'),
                runner: app.get('roomActionRunner'),
                deleteAction: app.get('deleteAction'),
                clock: app.get('roomSweepClock'),
                logger: app.get('logger'),
                maxIdleMs: app.get('config').staleRoomMaxIdleMs,
            });
        });
    }

    boot(app) {
        const sweeper = app.get('roomSweeper');
        app.get('httpServer').on('listening', () => sweeper.start());
    }

    shutdown(app) {
        app.get('roomSweeper').stop();
    }
}
