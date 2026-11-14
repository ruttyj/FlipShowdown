import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AccessPolicy } from '../../src/actions/AccessPolicy.js';
import { SYSTEM_USER } from '../../src/domain/entities.js';
import { ActionError } from '../../src/domain/errors.js';

// AccessPolicy only reads the unit of work's user, isAdmin, room and caller Player, so these tests
// use a stand-in for it.

const ROOM = { id: 'room-1', host_email: 'host@example.com' };

/** A unit of work stand-in. `isMember` decides whether the caller has a Player. */
function workFor(email, { isAdmin = false, isMember = false } = {}) {
    let callerPlayer = null;
    if (isMember) {
        callerPlayer = { id: 'player-1', email };
    }

    return {
        user: { email },
        isAdmin,
        room: ROOM,
        playerLookups: 0,
        findCallerPlayer() {
            this.playerLookups += 1;
            return callerPlayer;
        },
    };
}

/** Asserts that `action` throws an ActionError with this status and code. */
function assertActionError(action, status, code) {
    assert.throws(action, (error) => {
        assert.ok(error instanceof ActionError, `expected an ActionError, got ${error}`);
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        return true;
    });
}

describe('AccessPolicy#check', () => {
    const policy = new AccessPolicy();

    test('signed_in and system let anyone in without looking up players', () => {
        const outsider = workFor('outsider@example.com');
        const server = workFor(SYSTEM_USER.email);

        policy.check(outsider, 'signed_in');
        policy.check(server, 'system');

        assert.equal(outsider.playerLookups, 0);
        assert.equal(server.playerLookups, 0);
    });

    test('member lets a player in and keeps out anyone else, admins included', () => {
        policy.check(workFor('guest@example.com', { isMember: true }), 'member');

        assertActionError(() => policy.check(workFor('outsider@example.com'), 'member'), 403, 'not_member');
        assertActionError(() => policy.check(workFor('admin@example.com', { isAdmin: true }), 'member'), 403, 'not_member');
    });

    test('host lets in the host by email and any admin, member or not', () => {
        policy.check(workFor('host@example.com'), 'host');
        policy.check(workFor('admin@example.com', { isAdmin: true }), 'host');
    });

    test('host answers not_member to a stranger and not_host to a player who is not the host', () => {
        assertActionError(() => policy.check(workFor('outsider@example.com'), 'host'), 403, 'not_member');
        assertActionError(() => policy.check(workFor('guest@example.com', { isMember: true }), 'host'), 403, 'not_host');
    });

    test('an unknown access level throws a plain Error rather than letting the caller in', () => {
        assert.throws(() => policy.check(workFor('host@example.com', { isMember: true }), 'hosts'), (error) => {
            assert.ok(!(error instanceof ActionError));
            assert.match(error.message, /Unknown access level: hosts/);
            return true;
        });
    });
});

describe('AccessPolicy#isHost', () => {
    const policy = new AccessPolicy();

    test('is true for the room host_email and for admins only', () => {
        assert.equal(policy.isHost(workFor('host@example.com')), true);
        assert.equal(policy.isHost(workFor('admin@example.com', { isAdmin: true })), true);
        assert.equal(policy.isHost(workFor('guest@example.com', { isMember: true })), false);
        assert.equal(policy.isHost(workFor(SYSTEM_USER.email)), false);
    });
});
