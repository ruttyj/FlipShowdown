import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CloseAction } from '../../../src/actions/rooms/CloseAction.js';
import { CreateRoomAction } from '../../../src/actions/rooms/CreateRoomAction.js';
import { DeleteRoomAction } from '../../../src/actions/rooms/DeleteRoomAction.js';
import { LookupByCodeAction } from '../../../src/actions/rooms/LookupByCodeAction.js';
import { SetGameModeAction } from '../../../src/actions/rooms/SetGameModeAction.js';
import { StartAction } from '../../../src/actions/rooms/StartAction.js';
import { createRoomActions } from '../../../src/actions/rooms/index.js';
import { OPEN_STATUSES } from '../../../src/domain/entities.js';
import { ActionError } from '../../../src/domain/errors.js';

// The room action handlers on a fake RoomService: what each declares, how it parses the body and
// which service method it calls with what, plus the by-code lookup's answers. RoomService.test
// covers the rules themselves.

const WORK = { marker: 'the unit of work' };

/** A RoomService stand-in that records each call as [method, ...args] and returns `result`. */
function fakeRoomService(result) {
    const calls = [];
    const record = (method) => {
        return (...args) => {
            calls.push([method, ...args]);
            return result;
        };
    };
    return {
        calls,
        createRoom: record('createRoom'),
        setGameMode: record('setGameMode'),
        start: record('start'),
        close: record('close'),
        deleteRoom: record('deleteRoom'),
    };
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

describe('room actions', () => {
    test('createRoomActions registers set-game-mode, start, close and delete on the given service', () => {
        const roomService = fakeRoomService();

        const handlers = createRoomActions({ roomService });

        assert.deepEqual(
            handlers.map((handler) => handler.name),
            ['set-game-mode', 'start', 'close', 'delete'],
        );
        for (const handler of handlers) {
            assert.equal(handler.roomService, roomService);
            assert.equal(handler.access, 'host');
        }
    });

    test('start runs in a waiting room and calls RoomService#start', () => {
        const roomService = fakeRoomService();
        const handler = new StartAction({ roomService });

        assert.deepEqual(handler.allowedStatuses, ['waiting']);
        assert.equal(handler.handle(WORK, {}), undefined);
        assert.deepEqual(roomService.calls, [['start', WORK]]);
    });

    test('close and delete run in any status', () => {
        const roomService = fakeRoomService();
        const close = new CloseAction({ roomService });
        const remove = new DeleteRoomAction({ roomService });

        assert.equal(close.allowedStatuses, null);
        assert.equal(remove.allowedStatuses, null);
        close.handle(WORK, {});
        remove.handle(WORK, {});
        assert.deepEqual(roomService.calls, [['close', WORK], ['deleteRoom', WORK]]);
    });

    test('set-game-mode runs in an open room and passes the requested mode', () => {
        const roomService = fakeRoomService();
        const handler = new SetGameModeAction({ roomService });

        assert.equal(handler.allowedStatuses, OPEN_STATUSES);
        handler.handle(WORK, { game_mode: 'vengeance' });
        assert.deepEqual(roomService.calls, [['setGameMode', WORK, 'vengeance']]);
    });

    test('set-game-mode rejects a missing or unknown mode before calling the service', () => {
        const roomService = fakeRoomService();
        const handler = new SetGameModeAction({ roomService });

        assertBadRequest(() => handler.handle(WORK, {}), 'game_mode is not a game mode');
        assertBadRequest(() => handler.handle(WORK, { game_mode: 'chess' }), 'game_mode is not a game mode');
        assert.deepEqual(roomService.calls, []);
    });

    // --- Create ----------------------------------------------------------

    test('create is open to anyone signed in, with no status to check', () => {
        const handler = new CreateRoomAction({ roomService: fakeRoomService() });

        assert.equal(handler.access, 'signed_in');
        assert.equal(handler.allowedStatuses, null);
    });

    test('create passes the parsed body and returns the service\'s result', () => {
        const result = { player: { id: 'p1' } };
        const roomService = fakeRoomService(result);
        const handler = new CreateRoomAction({ roomService });

        const returned = handler.handle(WORK, { max_score: 150, game_mode: 'brutal', name: '  Olive  ' });

        assert.equal(returned, result);
        assert.deepEqual(roomService.calls, [
            ['createRoom', WORK, { maxScore: 150, gameMode: 'brutal', name: 'Olive' }],
        ]);
    });

    test('create defaults to classic and to no name', () => {
        const roomService = fakeRoomService();
        const handler = new CreateRoomAction({ roomService });

        handler.handle(WORK, { max_score: 200, name: '   ' });

        assert.deepEqual(roomService.calls, [['createRoom', WORK, { maxScore: 200, gameMode: 'classic', name: null }]]);
    });

    test('create rejects a max_score that isn\'t a positive integer', () => {
        const roomService = fakeRoomService();
        const handler = new CreateRoomAction({ roomService });

        for (const maxScore of [undefined, 0, -5, 1.5, '200']) {
            assertBadRequest(() => handler.handle(WORK, { max_score: maxScore }), 'max_score must be a positive integer');
        }
        assert.deepEqual(roomService.calls, []);
    });

    test('create rejects an unknown game mode', () => {
        const roomService = fakeRoomService();
        const handler = new CreateRoomAction({ roomService });

        assertBadRequest(() => handler.handle(WORK, { max_score: 200, game_mode: null }), 'game_mode is not a game mode');
        assert.deepEqual(roomService.calls, []);
    });
});

describe('LookupByCodeAction', () => {
    const USER = { email: 'ann@example.com' };

    test('answers 200 with what RoomService#lookupByCode returns for the caller\'s email', () => {
        const calls = [];
        const roomService = {
            lookupByCode(email, rawCode) {
                calls.push([email, rawCode]);
                return { room: { id: 'r1' }, players: [], my_player: null };
            },
        };

        const result = new LookupByCodeAction({ roomService }).lookup(USER, ' abcdef ');

        assert.deepEqual(result, { status: 200, body: { room: { id: 'r1' }, players: [], my_player: null } });
        assert.deepEqual(calls, [['ann@example.com', ' abcdef ']]);
    });

    test('answers an ActionError with its status and body', () => {
        const roomService = {
            lookupByCode() {
                throw new ActionError(404, 'room_not_found', 'Room not found');
            },
        };

        assert.deepEqual(new LookupByCodeAction({ roomService }).lookup(USER, 'NOPE22'), {
            status: 404,
            body: { message: 'Room not found', code: 'room_not_found' },
        });
    });

    test('rethrows any other error', () => {
        const failure = new Error('disk on fire');
        const roomService = {
            lookupByCode() {
                throw failure;
            },
        };

        assert.throws(() => new LookupByCodeAction({ roomService }).lookup(USER, 'ABCDEF'), failure);
    });
});
