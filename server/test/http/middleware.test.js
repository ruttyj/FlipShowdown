import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { StoreError } from '../../src/domain/errors.js';
import { apiNotFound } from '../../src/http/middleware/apiNotFound.js';
import { createErrorHandler, handleStoreError } from '../../src/http/middleware/errorHandler.js';
import { requireArrayOfObjectsBody, requireObjectBody } from '../../src/http/middleware/jsonBody.js';
import { createRequireUser } from '../../src/http/middleware/requireUser.js';
import { fakeResponse, recordingNext } from './httpHarness.js';

// The shared middleware called directly with fake requests and responses. api.test.js,
// http.test.js and lockdown.test.js cover it mounted in the real server.

// --- requireUser ---------------------------------------------------------

describe('requireUser', () => {
    function setup(identity) {
        const seen = [];
        const authenticator = {
            async authenticate(headers) {
                seen.push(headers);
                return identity;
            },
        };
        const users = {
            findOrCreate: (found) => ({ id: 'u1', email: found.email }),
        };
        return { seen, requireUser: createRequireUser({ authenticator, users }) };
    }

    test('answers 401 without a valid identity and stops the chain', async () => {
        const { requireUser } = setup(null);
        const res = fakeResponse();
        const next = recordingNext();

        await requireUser({ headers: {} }, res, next);

        assert.equal(res.statusCode, 401);
        assert.deepEqual(res.body, { message: 'Authentication required' });
        assert.deepEqual(next.calls, []);
    });

    test('sets req.user from the identity the request headers give', async () => {
        const { seen, requireUser } = setup({ email: 'ann@example.com', full_name: 'Ann' });
        const headers = { cookie: 'x=1' };
        const req = { headers };
        const next = recordingNext();

        await requireUser(req, fakeResponse(), next);

        assert.deepEqual(seen, [headers]);
        assert.deepEqual(req.user, { id: 'u1', email: 'ann@example.com' });
        assert.deepEqual(next.calls, [[]]);
    });
});

// --- jsonBody ------------------------------------------------------------

describe('requireObjectBody', () => {
    test('passes an object body through untouched', () => {
        const check = requireObjectBody({ message: 'Bad' });
        const body = { a: 1 };
        const req = { body };
        const next = recordingNext();

        check(req, fakeResponse(), next);

        assert.equal(req.body, body);
        assert.deepEqual(next.calls, [[]]);
    });

    test('answers 400 with only the message for an array, null or missing body', () => {
        const check = requireObjectBody({ message: 'Bad' });
        for (const body of [[], null, undefined, 'text']) {
            const res = fakeResponse();
            const next = recordingNext();

            check({ body }, res, next);

            assert.equal(res.statusCode, 400);
            assert.deepEqual(res.body, { message: 'Bad' });
            assert.deepEqual(next.calls, []);
        }
    });

    test('adds the code when one is given', () => {
        const check = requireObjectBody({ message: 'Bad', code: 'bad_request' });
        const res = fakeResponse();

        check({ body: [] }, res, recordingNext());

        assert.deepEqual(res.body, { message: 'Bad', code: 'bad_request' });
    });

    test('with missingAsEmpty, a missing body becomes {} but null is still refused', () => {
        const check = requireObjectBody({ message: 'Bad', missingAsEmpty: true });
        const req = { body: undefined };
        const next = recordingNext();

        check(req, fakeResponse(), next);

        assert.deepEqual(req.body, {});
        assert.deepEqual(next.calls, [[]]);

        const res = fakeResponse();
        check({ body: null }, res, recordingNext());
        assert.equal(res.statusCode, 400);
    });
});

describe('requireArrayOfObjectsBody', () => {
    const check = requireArrayOfObjectsBody({ message: 'Need objects' });

    test('passes an array of objects, including an empty one', () => {
        for (const body of [[], [{ a: 1 }, { b: 2 }]]) {
            const next = recordingNext();
            check({ body }, fakeResponse(), next);
            assert.deepEqual(next.calls, [[]]);
        }
    });

    test('answers 400 for an object, or an array holding a non-object', () => {
        for (const body of [{ a: 1 }, [{ a: 1 }, 2], [[]], undefined]) {
            const res = fakeResponse();
            const next = recordingNext();

            check({ body }, res, next);

            assert.equal(res.statusCode, 400);
            assert.deepEqual(res.body, { message: 'Need objects' });
            assert.deepEqual(next.calls, []);
        }
    });
});

// --- Errors --------------------------------------------------------------

describe('handleStoreError', () => {
    test('answers a StoreError with its own status and body', () => {
        const error = new StoreError(409, 'conflict', 'Already a member');
        const res = fakeResponse();
        const next = recordingNext();

        handleStoreError(error, {}, res, next);

        assert.equal(res.statusCode, 409);
        assert.deepEqual(res.body, error.toBody());
        assert.deepEqual(next.calls, []);
    });

    test('passes any other error on', () => {
        const error = new Error('disk on fire');
        const res = fakeResponse();
        const next = recordingNext();

        handleStoreError(error, {}, res, next);

        assert.deepEqual(next.calls, [[error]]);
        assert.equal(res.body, undefined);
    });
});

describe('createErrorHandler', () => {
    function setup() {
        const logged = [];
        const logger = { error: (...args) => logged.push(args) };
        return { logged, handleError: createErrorHandler(logger) };
    }

    const request = { method: 'POST', originalUrl: '/api/x' };

    test('a malformed JSON body is a 400 and is not logged', () => {
        const { logged, handleError } = setup();
        const res = fakeResponse();

        handleError({ type: 'entity.parse.failed' }, request, res, recordingNext());

        assert.equal(res.statusCode, 400);
        assert.deepEqual(res.body, { message: 'Invalid JSON body' });
        assert.deepEqual(logged, []);
    });

    test('an oversized body is a 413 and is not logged', () => {
        const { logged, handleError } = setup();
        const res = fakeResponse();

        handleError({ type: 'entity.too.large' }, request, res, recordingNext());

        assert.equal(res.statusCode, 413);
        assert.deepEqual(res.body, { message: 'Request body too large' });
        assert.deepEqual(logged, []);
    });

    test('anything else is logged with the request and answered 500', () => {
        const { logged, handleError } = setup();
        const error = new Error('boom');
        const res = fakeResponse();

        handleError(error, request, res, recordingNext());

        assert.deepEqual(logged, [['Unhandled error on POST /api/x', error]]);
        assert.equal(res.statusCode, 500);
        assert.deepEqual(res.body, { message: 'Internal server error' });
    });

    test('a response already under way is ended instead', () => {
        const { logged, handleError } = setup();
        const res = fakeResponse();
        res.headersSent = true;

        handleError(new Error('late'), request, res, recordingNext());

        assert.equal(logged.length, 1);
        assert.equal(res.ended, true);
        assert.equal(res.body, undefined);
    });
});

describe('apiNotFound', () => {
    test('answers 404 Not found', () => {
        const res = fakeResponse();

        apiNotFound({}, res);

        assert.equal(res.statusCode, 404);
        assert.deepEqual(res.body, { message: 'Not found' });
    });
});
