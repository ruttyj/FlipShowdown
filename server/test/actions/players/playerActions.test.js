import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { JoinAction } from '../../../src/actions/players/JoinAction.js';
import { KickAction } from '../../../src/actions/players/KickAction.js';
import { LeaveAction } from '../../../src/actions/players/LeaveAction.js';
import { MakeHostAction } from '../../../src/actions/players/MakeHostAction.js';
import { ReorderAction } from '../../../src/actions/players/ReorderAction.js';
import { createPlayerActions } from '../../../src/actions/players/index.js';
import { OPEN_STATUSES } from '../../../src/domain/entities.js';
import { ActionError } from '../../../src/domain/errors.js';

// The player action handlers: what each declares, how it parses the body and what it passes to
// PlayerService. The service is a stub that records its calls; PlayerService.test covers the rules.

const WORK = { marker: 'the unit of work' };

/** A PlayerService stand-in: each method records [name, ...args after work] and returns `result`. */
function createStubService(result) {
    const calls = [];
    const record = (name) => {
        return (work, ...args) => {
            assert.equal(work, WORK);
            calls.push([name, ...args]);
            return result;
        };
    };
    const service = {
        join: record('join'),
        leave: record('leave'),
        kick: record('kick'),
        makeHost: record('makeHost'),
        reorder: record('reorder'),
    };
    return { service, calls };
}

function assertBadRequest(action, message) {
    assert.throws(action, (error) => {
        assert.ok(error instanceof ActionError, `expected an ActionError, got ${error}`);
        assert.equal(error.status, 400);
        assert.equal(error.code, 'bad_request');
        assert.equal(error.message, message);
        return true;
    });
}

describe('createPlayerActions', () => {
    test('builds one handler per player action, sharing the service', () => {
        const { service } = createStubService();
        const handlers = createPlayerActions({ playerService: service });

        assert.deepEqual(
            handlers.map((handler) => handler.name),
            ['join', 'leave', 'kick', 'make-host', 'reorder'],
        );
        for (const handler of handlers) {
            assert.equal(handler.playerService, service);
        }
    });
});

describe('player action declarations', () => {
    const expected = [
        [JoinAction, 'signed_in', OPEN_STATUSES],
        [LeaveAction, 'signed_in', null],
        [KickAction, 'host', OPEN_STATUSES],
        [MakeHostAction, 'host', OPEN_STATUSES],
        [ReorderAction, 'host', ['waiting']],
    ];
    for (const [ActionClass, access, allowedStatuses] of expected) {
        test(`${ActionClass.name} is ${access}, allowed in ${JSON.stringify(allowedStatuses)}`, () => {
            const handler = new ActionClass({ playerService: null });

            assert.equal(handler.access, access);
            assert.deepEqual(handler.allowedStatuses, allowedStatuses);
        });
    }
});

describe('JoinAction', () => {
    test('passes the normalised name and returns the service result', () => {
        const result = { player: { id: 'p1' }, already_joined: false };
        const { service, calls } = createStubService(result);

        const returned = new JoinAction({ playerService: service }).handle(WORK, { name: '  Ann  ' });

        assert.equal(returned, result);
        assert.deepEqual(calls, [['join', 'Ann']]);
    });

    test('passes null for a missing or blank name, for the service to judge', () => {
        const { service, calls } = createStubService();
        const handler = new JoinAction({ playerService: service });

        handler.handle(WORK, {});
        handler.handle(WORK, { name: '   ' });
        handler.handle(WORK, { name: 42 });

        assert.deepEqual(calls, [
            ['join', null],
            ['join', null],
            ['join', null],
        ]);
    });
});

describe('LeaveAction', () => {
    test('calls leave and returns nothing', () => {
        const { service, calls } = createStubService('ignored');

        const returned = new LeaveAction({ playerService: service }).handle(WORK, {});

        assert.equal(returned, undefined);
        assert.deepEqual(calls, [['leave']]);
    });
});

describe('player_id actions', () => {
    const cases = [
        [KickAction, 'kick'],
        [MakeHostAction, 'makeHost'],
    ];
    for (const [ActionClass, method] of cases) {
        test(`${ActionClass.name} passes player_id to ${method} and returns nothing`, () => {
            const { service, calls } = createStubService('ignored');

            const returned = new ActionClass({ playerService: service }).handle(WORK, { player_id: 'p2' });

            assert.equal(returned, undefined);
            assert.deepEqual(calls, [[method, 'p2']]);
        });

        test(`${ActionClass.name} rejects a missing, empty or non-string player_id`, () => {
            const { service, calls } = createStubService();
            const handler = new ActionClass({ playerService: service });

            for (const body of [{}, { player_id: '' }, { player_id: 7 }]) {
                assertBadRequest(() => handler.handle(WORK, body), 'player_id must be a non-empty string');
            }
            assert.deepEqual(calls, []);
        });
    }
});

describe('ReorderAction', () => {
    test('passes player_ids to reorder and returns nothing', () => {
        const { service, calls } = createStubService('ignored');

        const returned = new ReorderAction({ playerService: service }).handle(WORK, { player_ids: ['b', 'a'] });

        assert.equal(returned, undefined);
        assert.deepEqual(calls, [['reorder', ['b', 'a']]]);
    });

    test('rejects player_ids that is not a list of strings', () => {
        const { service, calls } = createStubService();
        const handler = new ReorderAction({ playerService: service });

        for (const body of [{}, { player_ids: 'a' }, { player_ids: ['a', 3] }]) {
            assertBadRequest(
                () => handler.handle(WORK, body),
                'player_ids must list every player in the room exactly once',
            );
        }
        assert.deepEqual(calls, []);
    });
});
