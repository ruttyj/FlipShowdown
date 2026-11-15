import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { verifySessionToken } from '../../src/services/auth.js';
import { UserService } from '../../src/services/UserService.js';
import { openTempStore } from '../actions/roomFixture.js';

// UserService on a real temp store.

const SECRET = 'test-secret';

describe('UserService', () => {
    let temp;
    let users;

    beforeEach(() => {
        temp = openTempStore();
        users = new UserService({
            store: temp.store,
            adminEmails: new Set(['boss@example.com']),
            sessionSecret: SECRET,
        });
    });

    afterEach(() => {
        temp.close();
    });

    test('findOrCreate creates a user on first sight and finds them after', () => {
        const created = users.findOrCreate({ email: 'ann@example.com', full_name: 'Ann' });
        const found = users.findOrCreate({ email: 'ann@example.com', full_name: 'Someone else' });

        assert.equal(created.full_name, 'Ann');
        assert.deepEqual(found, created);
    });

    test('rename trims the new name, and an undefined name keeps the user as is', () => {
        const user = users.findOrCreate({ email: 'ann@example.com', full_name: 'Ann' });

        assert.equal(users.rename(user, undefined), user);
        assert.equal(users.rename(user, '  Annie  ').full_name, 'Annie');
        assert.equal(users.rename(user, null).full_name, null);
    });

    test('startDevSession signs a token for the user, keeping a stored name over an empty one', () => {
        users.findOrCreate({ email: 'ann@example.com', full_name: 'Ann' });

        const token = users.startDevSession('ann@example.com', null);

        assert.deepEqual(verifySessionToken(SECRET, token), { email: 'ann@example.com', full_name: 'Ann' });
    });

    test('toResponse derives the role from the admin list', () => {
        const ann = users.findOrCreate({ email: 'ann@example.com', full_name: 'Ann' });
        const boss = users.findOrCreate({ email: 'boss@example.com', full_name: 'Boss' });

        assert.deepEqual(users.toResponse(ann), {
            id: ann.id,
            email: 'ann@example.com',
            full_name: 'Ann',
            role: 'user',
            created_date: ann.created_date,
            updated_date: ann.updated_date,
        });
        assert.equal(users.toResponse(boss).role, 'admin');
    });
});
