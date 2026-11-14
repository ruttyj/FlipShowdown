import { AccessPolicy } from '../actions/AccessPolicy.js';
import { createActionRegistry, createServices } from '../actions/createGameActions.js';
import { RoomActionRunner } from '../actions/RoomActionRunner.js';
import { CreateRoomAction, LookupByCodeAction } from '../actions/rooms/index.js';
import { createVoteTopics } from '../actions/VoteTopics.js';
import { BaseProvider } from './BaseProvider.js';

// The game actions: one set of services, handlers and runner shared by the rooms router, the
// hold-to-vote topics and the stale-room sweep.

export class GameProvider extends BaseProvider {
    register(app) {
        app.register('gameServices', () => {
            return createServices(app.get('repositories'));
        });
        app.register('actionRegistry', () => {
            return createActionRegistry(app.get('gameServices'));
        });
        app.register('createRoomAction', () => {
            return new CreateRoomAction(app.get('gameServices'));
        });
        app.register('lookupByCodeAction', () => {
            return new LookupByCodeAction(app.get('gameServices'));
        });
        // The handlers the server runs itself: make-host for a passed vote, delete for the sweep.
        app.register('makeHostAction', () => {
            return app.get('actionRegistry').require('make-host');
        });
        app.register('deleteAction', () => {
            return app.get('actionRegistry').require('delete');
        });
        app.register('roomActionRunner', () => {
            return new RoomActionRunner({
                database: app.get('database'),
                repositories: app.get('repositories'),
                store: app.get('store'),
                accessPolicy: new AccessPolicy(),
                adminEmails: app.get('config').adminEmails,
                // Looked up when the runner publishes rather than passed in: the hub's vote topics
                // need this runner, so passing the hub would be a dependency cycle.
                getHub: () => app.get('hub'),
                logger: app.get('logger'),
            });
        });
        app.register('voteTopics', () => {
            return createVoteTopics({
                runner: app.get('roomActionRunner'),
                makeHostAction: app.get('makeHostAction'),
            });
        });
    }

    boot(app) {
        // Resolved now, so a renamed action stops the server from starting instead of failing at
        // the first vote or sweep.
        app.get('makeHostAction');
        app.get('deleteAction');
    }
}
