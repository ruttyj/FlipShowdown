import { openStore } from '../database/db.js';
import { EntityGateway } from '../repositories/EntityGateway.js';
import { BaseProvider } from './BaseProvider.js';

// The SQLite store: `store` is the db.js facade, `database` the Database its transactions run on,
// `repositories` its table repositories and `entityGateway` the record-shaped access to every
// entity over them. Production parts take `database`, `repositories` or `entityGateway`; only the
// call sites a test pins take `store` (see docs/testing.md). Shutting down closes the database; it
// runs last, after the HTTP server has finished its requests.

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
        app.register('entityGateway', () => {
            return new EntityGateway(app.get('database'), app.get('repositories'));
        });
    }

    shutdown(app) {
        app.get('store').close();
    }
}
