import { openStore } from '../database/db.js';
import { BaseProvider } from './BaseProvider.js';

// The SQLite store: `store` is the db.js facade (tests still use it), `database` the Database its
// transactions run on and `repositories` its table repositories. Shutting down closes the
// database; it runs last, after the HTTP server has finished its requests.

export class DatabaseProvider extends BaseProvider {
    register(app) {
        app.register('store', () => {
            const config = app.get('config');
            return openStore(config.dataDir, { eventLogLimit: app.options.eventLogLimit });
        });
        app.register('database', () => {
            return app.get('store').database;
        });
        app.register('repositories', () => {
            return app.get('store').repositories;
        });
    }

    shutdown(app) {
        app.get('store').close();
    }
}
