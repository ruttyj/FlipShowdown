import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import express from 'express';
import { RoomsController } from '../../src/http/controllers/RoomsController.js';
import { serveApp, signedInAs } from './httpHarness.js';

// RoomsController over a fake runner, registry and room actions: what each route hands the runner
// and how it answers. rooms.test.js covers the real actions end to end.

const USER = { email: 'ann@example.com' };

describe('RoomsController', () => {
    const createRoom = { name: 'create-room' };
    const advance = { name: 'advance-round' };
    let runs;
    let lookups;
    let harness;

    before(async () => {
        const controller = new RoomsController({
            runner: {
                run(handler, request) {
                    runs.push({ handler, request });
                    return { status: 201, body: { ran: handler.name } };
                },
            },
            registry: {
                get: (name) => (name === 'advance-round' ? advance : undefined),
            },
            createRoom,
            lookupByCode: {
                lookup(user, code) {
                    lookups.push({ user, code });
                    return { status: 200, body: { room: code } };
                },
            },
        });
        harness = await serveApp((app) => {
            app.use(express.json());
            app.use('/api/rooms', signedInAs(USER), controller.router());
        });
    });

    beforeEach(() => {
        runs = [];
        lookups = [];
    });

    after(async () => {
        await harness.close();
    });

    test('POST / runs the create-room action with the body and no room', async () => {
        const response = await harness.request('POST', '/api/rooms', { body: { max_score: 200 } });

        assert.equal(response.status, 201);
        assert.deepEqual(response.body, { ran: 'create-room' });
        assert.equal(runs.length, 1);
        assert.equal(runs[0].handler, createRoom);
        assert.deepEqual(runs[0].request, { user: USER, roomId: null, body: { max_score: 200 } });
    });

    test('a missing body is an empty one', async () => {
        await harness.request('POST', '/api/rooms');

        assert.deepEqual(runs[0].request.body, {});
    });

    test('a body that is not an object is a 400 bad_request and runs nothing', async () => {
        const response = await harness.request('POST', '/api/rooms/r1/actions/advance-round', { body: [1] });

        assert.equal(response.status, 400);
        assert.deepEqual(response.body, { message: 'Body must be a JSON object', code: 'bad_request' });
        assert.deepEqual(runs, []);
    });

    test('GET /by-code/:code answers with the lookup', async () => {
        const response = await harness.request('GET', '/api/rooms/by-code/ABCDEF');

        assert.equal(response.status, 200);
        assert.deepEqual(response.body, { room: 'ABCDEF' });
        assert.deepEqual(lookups, [{ user: USER, code: 'ABCDEF' }]);
    });

    test('an action runs its registered handler on the named room', async () => {
        const response = await harness.request('POST', '/api/rooms/r1/actions/advance-round', { body: { round: 2 } });

        assert.equal(response.status, 201);
        assert.equal(runs[0].handler, advance);
        assert.deepEqual(runs[0].request, { user: USER, roomId: 'r1', body: { round: 2 } });
    });

    test('an unknown action is a 404 before its body is checked', async () => {
        const response = await harness.request('POST', '/api/rooms/r1/actions/fly', { body: [1] });

        assert.equal(response.status, 404);
        assert.deepEqual(response.body, { message: 'Unknown action: fly' });
        assert.deepEqual(runs, []);
    });
});
