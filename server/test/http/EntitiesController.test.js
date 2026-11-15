import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import express from 'express';
import { StoreError } from '../../src/domain/errors.js';
import { EntitiesController } from '../../src/http/controllers/EntitiesController.js';
import { serveApp, signedInAs } from './httpHarness.js';

// EntitiesController over a fake EntityService: the order a route runs its checks in, and how it
// answers each service result. api.test.js and lockdown.test.js cover the real service.

const USER = { email: 'ann@example.com' };

/** A fake EntityService: `allowed` sets what each can* check answers; `calls` records the rest. */
function createFakeEntities() {
    const fake = {
        allowed: {},
        calls: [],
        records: new Map(),
        failNextWrite: null,
    };
    const canMethods = ['canList', 'canGet', 'canCreate', 'canBulkCreate', 'canModify'];
    for (const method of canMethods) {
        fake[method] = (...args) => {
            fake.calls.push([method, ...args]);
            return fake.allowed[method] ?? true;
        };
    }

    fake.isEntity = (name) => name === 'Note';
    fake.list = (entityName, query) => {
        fake.calls.push(['list', entityName, query]);
        return [{ id: 'n1' }];
    };
    fake.get = (entityName, id) => fake.records.get(id) ?? null;
    fake.create = (entityName, items, createdBy) => {
        fake.calls.push(['create', entityName, items, createdBy]);
        if (fake.failNextWrite) {
            const error = fake.failNextWrite;
            fake.failNextWrite = null;
            throw error;
        }
        return items.map((item, index) => ({ id: `new${index}`, ...item }));
    };
    fake.update = (entityName, id, changes) => {
        const record = fake.records.get(id);
        if (!record) {
            return null;
        }
        return { ...record, ...changes };
    };
    fake.remove = (entityName, id) => fake.records.get(id) ?? null;
    return fake;
}

describe('EntitiesController', () => {
    let entities;
    let harness;

    before(async () => {
        entities = createFakeEntities();
        const controller = new EntitiesController({ entities });
        harness = await serveApp((app) => {
            app.use(express.json());
            app.use('/api/entities', signedInAs(USER), controller.router());
        });
    });

    beforeEach(() => {
        entities.allowed = {};
        entities.calls = [];
        entities.records = new Map([['n1', { id: 'n1', text: 'hi' }]]);
    });

    after(async () => {
        await harness.close();
    });

    test('an entity the API does not serve is a 404 before any check', async () => {
        const response = await harness.request('GET', '/api/entities/Secret');

        assert.equal(response.status, 404);
        assert.deepEqual(response.body, { message: 'Unknown entity: Secret' });
        assert.deepEqual(entities.calls, []);
    });

    test('a list parses the query and answers the page', async () => {
        const response = await harness.request('GET', '/api/entities/Note?limit=5');

        assert.equal(response.status, 200);
        assert.deepEqual(response.body, [{ id: 'n1' }]);
        const [check, user, checkedName, rawQuery] = entities.calls[0];
        assert.deepEqual([check, user, checkedName], ['canList', USER, 'Note']);
        // Express gives the raw query a null prototype.
        assert.deepEqual({ ...rawQuery }, { limit: '5' });
        const [, entityName, query] = entities.calls[1];
        assert.equal(entityName, 'Note');
        assert.equal(query.limit, 5);
    });

    test('a malformed list query is a 400 with the parser message', async () => {
        const response = await harness.request('GET', '/api/entities/Note?q=nope');

        assert.equal(response.status, 400);
        assert.equal(typeof response.body.message, 'string');
        assert.deepEqual(entities.calls.map((call) => call[0]), ['canList']);
    });

    test('a refused check is a 403 forbidden, before the body is checked', async () => {
        entities.allowed.canCreate = false;

        const response = await harness.request('POST', '/api/entities/Note', { body: [1] });

        assert.equal(response.status, 403);
        assert.deepEqual(response.body, { message: 'Not allowed', code: 'forbidden' });
    });

    test('a create answers 201 with the one record, created by the user', async () => {
        const response = await harness.request('POST', '/api/entities/Note', { body: { text: 'yo' } });

        assert.equal(response.status, 201);
        assert.deepEqual(response.body, { id: 'new0', text: 'yo' });
        assert.deepEqual(entities.calls[1], ['create', 'Note', [{ text: 'yo' }], USER.email]);
    });

    test('a create with a body that is not an object is a 400 and writes nothing', async () => {
        const response = await harness.request('POST', '/api/entities/Note', { body: [] });

        assert.equal(response.status, 400);
        assert.deepEqual(response.body, { message: 'Body must be a JSON object' });
        assert.deepEqual(entities.calls.map((call) => call[0]), ['canCreate']);
    });

    test('a bulk create answers 201 with every record', async () => {
        const response = await harness.request('POST', '/api/entities/Note/bulk', { body: [{ a: 1 }, { b: 2 }] });

        assert.equal(response.status, 201);
        assert.deepEqual(response.body, [{ id: 'new0', a: 1 }, { id: 'new1', b: 2 }]);
    });

    test('a bulk create needs an array of objects', async () => {
        const response = await harness.request('POST', '/api/entities/Note/bulk', { body: { a: 1 } });

        assert.equal(response.status, 400);
        assert.deepEqual(response.body, { message: 'Body must be a JSON array of objects' });
    });

    test('a refused write answers with the StoreError', async () => {
        entities.failNextWrite = new StoreError(409, 'conflict', 'Taken');

        const response = await harness.request('POST', '/api/entities/Note', { body: {} });

        assert.equal(response.status, 409);
        assert.deepEqual(response.body, { message: 'Taken', code: 'conflict' });
    });

    test('any other write failure goes on to the app error handler', async () => {
        entities.failNextWrite = new Error('disk on fire');

        const response = await harness.request('POST', '/api/entities/Note', { body: {} });

        assert.equal(response.status, 500);
        assert.deepEqual(response.body, { message: 'disk on fire' });
    });

    test('get, update and delete answer the record, or 404 when there is none', async () => {
        assert.deepEqual((await harness.request('GET', '/api/entities/Note/n1')).body, { id: 'n1', text: 'hi' });
        const updated = await harness.request('PUT', '/api/entities/Note/n1', { body: { text: 'yo' } });
        assert.deepEqual(updated.body, { id: 'n1', text: 'yo' });
        const deleted = await harness.request('DELETE', '/api/entities/Note/n1');
        assert.deepEqual(deleted.body, { success: true });

        for (const method of ['GET', 'PUT', 'DELETE']) {
            let body;
            if (method === 'PUT') {
                body = {};
            }
            const response = await harness.request(method, '/api/entities/Note/missing', { body });
            assert.equal(response.status, 404, method);
            assert.deepEqual(response.body, { message: 'Record not found' });
        }
    });

    test('get, update and delete pass the user and id to their checks', async () => {
        entities.allowed = { canGet: false, canModify: false };

        const responses = [
            await harness.request('GET', '/api/entities/Note/n1'),
            await harness.request('PUT', '/api/entities/Note/n1', { body: [] }),
            await harness.request('DELETE', '/api/entities/Note/n1'),
        ];

        assert.deepEqual(responses.map((response) => response.status), [403, 403, 403]);
        assert.deepEqual(entities.calls, [
            ['canGet', USER, 'Note', 'n1'],
            ['canModify', USER, 'Note'],
            ['canModify', USER, 'Note'],
        ]);
    });
});
