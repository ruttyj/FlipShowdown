import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { createVoteTracker } from '../src/votes.js';

// Unit tests for the hold-to-vote state machine, on a fake clock.

const HOLD_MS = 3000;
const HOST_GRACE_MS = 120_000;
const ROOM = 'room-1';
const TOPIC = 'make-host';

/** setTimeout / clearTimeout / now that only move when `advance` is called. */
function createFakeClock() {
    let time = 0;
    let nextId = 1;
    const timers = new Map();

    return {
        now: () => time,
        setTimeout(callback, delayMs) {
            const id = nextId;
            nextId += 1;
            timers.set(id, { callback, dueAt: time + delayMs });
            return id;
        },
        clearTimeout(id) {
            timers.delete(id);
        },
        advance(ms) {
            time += ms;
            for (const [id, timer] of [...timers]) {
                if (timer.dueAt <= time) {
                    timers.delete(id);
                    timer.callback();
                }
            }
        },
    };
}

describe('vote tracker', () => {
    let clock;
    let passed;
    let changed;
    let votes;

    beforeEach(() => {
        clock = createFakeClock();
        passed = [];
        changed = [];
        votes = createVoteTracker({
            topics: [TOPIC],
            holdMs: HOLD_MS,
            hostGraceMs: HOST_GRACE_MS,
            timers: clock,
            now: clock.now,
            onPassed(roomId, topic, option) {
                passed.push({ roomId, topic, option });
            },
            onChanged(changes) {
                changed.push(...changes);
            },
        });
    });

    function setOnline(onlinePlayerIds, hostPlayerId = 'alice') {
        return votes.setElectorate(ROOM, { onlinePlayerIds, hostPlayerId });
    }

    function hold(socketId, playerId, option) {
        return votes.hold(ROOM, TOPIC, { socketId, playerId, option });
    }

    test('two holders of the same option pass after the hold time', () => {
        setOnline(['alice', 'bob']);
        hold('socket-a', 'alice', 'bob');
        assert.equal(votes.snapshot(ROOM, TOPIC).pending, null);

        hold('socket-b', 'bob', 'bob');
        clock.advance(1000);
        assert.deepEqual(votes.snapshot(ROOM, TOPIC), {
            eligible: ['alice', 'bob'],
            holds: [{ player_id: 'alice', option: 'bob' }, { player_id: 'bob', option: 'bob' }],
            pending: { option: 'bob', remaining_ms: 2000 },
            unlocks_in_ms: 0,
        });

        clock.advance(1999);
        assert.deepEqual(passed, []);
        clock.advance(1);
        assert.deepEqual(passed, [{ roomId: ROOM, topic: TOPIC, option: 'bob' }]);
        assert.deepEqual(votes.snapshot(ROOM, TOPIC).holds, []);
        assert.equal(votes.snapshot(ROOM, TOPIC).pending, null);
    });

    test('a release cancels the pending vote', () => {
        setOnline(['alice', 'bob']);
        hold('socket-a', 'alice', 'bob');
        hold('socket-b', 'bob', 'bob');
        clock.advance(2000);

        assert.deepEqual(votes.release(ROOM, TOPIC, 'socket-b'), [{ roomId: ROOM, topic: TOPIC }]);
        assert.equal(votes.snapshot(ROOM, TOPIC).pending, null);
        clock.advance(HOLD_MS * 2);
        assert.deepEqual(passed, []);
    });

    test('switching to a different option cancels, and agreeing again restarts the full hold', () => {
        setOnline(['alice', 'bob']);
        hold('socket-a', 'alice', 'bob');
        hold('socket-b', 'bob', 'bob');
        clock.advance(2000);

        hold('socket-b', 'bob', 'alice');
        assert.equal(votes.snapshot(ROOM, TOPIC).pending, null);
        assert.deepEqual(votes.snapshot(ROOM, TOPIC).holds[1], { player_id: 'bob', option: 'alice' });
        clock.advance(HOLD_MS);
        assert.deepEqual(passed, []);

        hold('socket-b', 'bob', 'bob');
        clock.advance(HOLD_MS - 1);
        assert.deepEqual(passed, []);
        clock.advance(1);
        assert.equal(passed.length, 1);
    });

    test('repeating the same hold changes nothing and keeps the timer', () => {
        setOnline(['alice', 'bob']);
        hold('socket-a', 'alice', 'bob');
        hold('socket-b', 'bob', 'bob');
        clock.advance(2000);

        assert.deepEqual(hold('socket-b', 'bob', 'bob'), []);
        clock.advance(1000);
        assert.equal(passed.length, 1);
    });

    test('a player coming online cancels the pending vote', () => {
        setOnline(['alice', 'bob']);
        hold('socket-a', 'alice', 'bob');
        hold('socket-b', 'bob', 'bob');
        clock.advance(2000);

        assert.deepEqual(setOnline(['alice', 'bob', 'carol']), [{ roomId: ROOM, topic: TOPIC }]);
        assert.equal(votes.snapshot(ROOM, TOPIC).pending, null);
        clock.advance(HOLD_MS * 2);
        assert.deepEqual(passed, []);
    });

    test('an unchanged electorate changes nothing; a forced one (join / leave / kick) restarts the hold', () => {
        setOnline(['alice', 'bob']);
        hold('socket-a', 'alice', 'bob');
        hold('socket-b', 'bob', 'bob');
        clock.advance(2000);

        assert.deepEqual(setOnline(['bob', 'alice']), []);
        votes.setElectorate(ROOM, { onlinePlayerIds: ['alice', 'bob'], hostPlayerId: 'alice' }, { force: true });
        assert.equal(votes.snapshot(ROOM, TOPIC).pending.remaining_ms, HOLD_MS);
        clock.advance(HOLD_MS - 1);
        assert.deepEqual(passed, []);
        clock.advance(1);
        assert.equal(passed.length, 1);
    });

    test('a single online player never passes while the host is online', () => {
        setOnline(['alice'], 'alice');
        hold('socket-a', 'alice', 'bob');
        clock.advance(HOLD_MS * 3);

        assert.equal(votes.snapshot(ROOM, TOPIC).pending, null);
        assert.deepEqual(passed, []);
    });

    test('a single online player passes when the host is offline', () => {
        setOnline(['bob'], 'alice');
        hold('socket-b', 'bob', 'bob');
        clock.advance(HOLD_MS);

        assert.deepEqual(passed, [{ roomId: ROOM, topic: TOPIC, option: 'bob' }]);
    });

    test('a host who just went offline blocks the vote for the grace period', () => {
        clock.advance(10_000);
        votes.setElectorate(ROOM, { onlinePlayerIds: ['bob', 'carol'], hostPlayerId: 'alice', hostOfflineSince: 5_000 });
        hold('socket-b', 'bob', 'bob');
        hold('socket-c', 'carol', 'bob');

        assert.equal(votes.snapshot(ROOM, TOPIC).pending, null);
        assert.equal(votes.snapshot(ROOM, TOPIC).unlocks_in_ms, HOST_GRACE_MS - 5_000);

        clock.advance(HOST_GRACE_MS - 5_000 - 1);
        assert.equal(votes.snapshot(ROOM, TOPIC).pending, null);
        assert.deepEqual(changed, []);

        clock.advance(1);
        assert.deepEqual(changed, [{ roomId: ROOM, topic: TOPIC }]);
        assert.equal(votes.snapshot(ROOM, TOPIC).unlocks_in_ms, 0);
        assert.equal(votes.snapshot(ROOM, TOPIC).pending.option, 'bob');
        clock.advance(HOLD_MS);
        assert.deepEqual(passed, [{ roomId: ROOM, topic: TOPIC, option: 'bob' }]);
    });

    test('a host offline for longer than the grace period does not block the vote', () => {
        clock.advance(HOST_GRACE_MS);
        votes.setElectorate(ROOM, { onlinePlayerIds: ['bob'], hostPlayerId: 'alice', hostOfflineSince: 0 });
        hold('socket-b', 'bob', 'bob');

        assert.equal(votes.snapshot(ROOM, TOPIC).unlocks_in_ms, 0);
        clock.advance(HOLD_MS);
        assert.equal(passed.length, 1);
    });

    test('the host coming back during the grace period cancels the unlock', () => {
        votes.setElectorate(ROOM, { onlinePlayerIds: ['bob'], hostPlayerId: 'alice', hostOfflineSince: 0 });
        setOnline(['alice', 'bob']);

        assert.equal(votes.snapshot(ROOM, TOPIC).unlocks_in_ms, 0);
        clock.advance(HOST_GRACE_MS);
        assert.deepEqual(changed, []);
    });

    test('an online host never blocks the vote, whatever hostOfflineSince says', () => {
        votes.setElectorate(ROOM, { onlinePlayerIds: ['alice', 'bob'], hostPlayerId: 'alice', hostOfflineSince: 0 });

        assert.equal(votes.snapshot(ROOM, TOPIC).unlocks_in_ms, 0);
    });

    test('forgetting a room cancels its grace timer', () => {
        votes.setElectorate(ROOM, { onlinePlayerIds: ['bob'], hostPlayerId: 'alice', hostOfflineSince: 0 });

        votes.forgetRoom(ROOM);
        clock.advance(HOST_GRACE_MS);
        assert.deepEqual(changed, []);
    });

    test('an offline player\'s hold is kept but neither listed nor counted', () => {
        setOnline(['alice', 'bob', 'carol']);
        hold('socket-c', 'carol', 'bob');
        setOnline(['alice', 'bob']);
        assert.deepEqual(votes.snapshot(ROOM, TOPIC).holds, []);

        setOnline(['alice', 'bob', 'carol']);
        assert.deepEqual(votes.snapshot(ROOM, TOPIC).holds, [{ player_id: 'carol', option: 'bob' }]);
    });

    test('two sockets of one user: closing one keeps the other\'s hold', () => {
        setOnline(['alice', 'bob']);
        hold('alice-phone', 'alice', 'bob');
        hold('alice-laptop', 'alice', 'bob');
        hold('socket-b', 'bob', 'bob');

        votes.dropSocket('alice-phone');
        assert.deepEqual(votes.snapshot(ROOM, TOPIC).holds[0], { player_id: 'alice', option: 'bob' });
        clock.advance(HOLD_MS);
        assert.equal(passed.length, 1);
    });

    test('a second socket repeating the same option keeps the timer running', () => {
        setOnline(['alice', 'bob']);
        hold('alice-phone', 'alice', 'bob');
        hold('socket-b', 'bob', 'bob');
        clock.advance(2000);

        assert.deepEqual(hold('alice-laptop', 'alice', 'bob'), []);
        assert.equal(votes.snapshot(ROOM, TOPIC).pending.remaining_ms, HOLD_MS - 2000);
        clock.advance(HOLD_MS - 2000);
        assert.equal(passed.length, 1);
    });

    test('one of a user\'s two sockets releasing while the other holds keeps the timer', () => {
        setOnline(['alice', 'bob']);
        hold('alice-phone', 'alice', 'bob');
        hold('alice-laptop', 'alice', 'bob');
        hold('socket-b', 'bob', 'bob');
        clock.advance(2000);

        assert.deepEqual(votes.release(ROOM, TOPIC, 'alice-phone'), []);
        assert.equal(votes.snapshot(ROOM, TOPIC).pending.remaining_ms, HOLD_MS - 2000);
        clock.advance(HOLD_MS - 2000);
        assert.equal(passed.length, 1);
    });

    test('an offline player\'s hold changing keeps the timer', () => {
        setOnline(['alice', 'bob', 'carol']);
        hold('socket-c', 'carol', 'alice');
        setOnline(['alice', 'bob']);
        hold('socket-a', 'alice', 'bob');
        hold('socket-b', 'bob', 'bob');
        clock.advance(2000);

        hold('socket-c', 'carol', 'bob');
        assert.equal(votes.snapshot(ROOM, TOPIC).pending.remaining_ms, HOLD_MS - 2000);
    });

    test('the last socket of a user closing drops the hold and cancels', () => {
        setOnline(['alice', 'bob']);
        hold('alice-phone', 'alice', 'bob');
        hold('socket-b', 'bob', 'bob');

        assert.deepEqual(votes.dropSocket('alice-phone'), [{ roomId: ROOM, topic: TOPIC }]);
        assert.deepEqual(votes.snapshot(ROOM, TOPIC).holds, [{ player_id: 'bob', option: 'bob' }]);
        clock.advance(HOLD_MS);
        assert.deepEqual(passed, []);
    });

    test('dropping a socket only in some rooms keeps its holds elsewhere', () => {
        setOnline(['alice', 'bob']);
        votes.setElectorate('room-2', { onlinePlayerIds: ['alice', 'bob'], hostPlayerId: 'alice' });
        hold('socket-a', 'alice', 'bob');
        votes.hold('room-2', TOPIC, { socketId: 'socket-a', playerId: 'alice', option: 'bob' });

        votes.dropSocket('socket-a', [ROOM]);
        assert.deepEqual(votes.snapshot(ROOM, TOPIC).holds, []);
        assert.equal(votes.snapshot('room-2', TOPIC).holds.length, 1);
    });

    test('forgetting a room cancels its timer', () => {
        setOnline(['alice', 'bob']);
        hold('socket-a', 'alice', 'bob');
        hold('socket-b', 'bob', 'bob');

        votes.forgetRoom(ROOM);
        clock.advance(HOLD_MS);
        assert.deepEqual(passed, []);
        assert.deepEqual(votes.snapshot(ROOM, TOPIC), { eligible: [], holds: [], pending: null, unlocks_in_ms: 0 });
    });
});

describe('vote tracker, topic the host decides', () => {
    let clock;
    let passed;
    let votes;

    beforeEach(() => {
        clock = createFakeClock();
        passed = [];
        votes = createVoteTracker({
            topics: [TOPIC],
            hostDecidesTopics: [TOPIC],
            holdMs: HOLD_MS,
            hostGraceMs: HOST_GRACE_MS,
            timers: clock,
            now: clock.now,
            onPassed(roomId, topic, option) {
                passed.push({ roomId, topic, option });
            },
        });
    });

    function setOnline(onlinePlayerIds, hostPlayerId = 'alice') {
        return votes.setElectorate(ROOM, { onlinePlayerIds, hostPlayerId });
    }

    function hold(socketId, playerId, option) {
        return votes.hold(ROOM, TOPIC, { socketId, playerId, option });
    }

    test('the online host holding alone passes after the full hold time', () => {
        setOnline(['alice', 'bob', 'carol']);
        hold('socket-c', 'carol', 'carol');
        hold('socket-a', 'alice', 'bob');
        assert.deepEqual(votes.snapshot(ROOM, TOPIC).pending, { option: 'bob', remaining_ms: HOLD_MS });

        clock.advance(HOLD_MS - 1);
        assert.deepEqual(passed, []);
        clock.advance(1);
        assert.deepEqual(passed, [{ roomId: ROOM, topic: TOPIC, option: 'bob' }]);
    });

    test('the host decides even when they are the only one online', () => {
        setOnline(['alice']);
        hold('socket-a', 'alice', 'bob');
        clock.advance(HOLD_MS);

        assert.deepEqual(passed, [{ roomId: ROOM, topic: TOPIC, option: 'bob' }]);
    });

    test('the host letting go cancels', () => {
        setOnline(['alice', 'bob']);
        hold('socket-a', 'alice', 'bob');
        clock.advance(2000);

        votes.release(ROOM, TOPIC, 'socket-a');
        assert.equal(votes.snapshot(ROOM, TOPIC).pending, null);
        clock.advance(HOLD_MS);
        assert.deepEqual(passed, []);
    });

    test('an offline host\'s hold does not decide', () => {
        setOnline(['alice', 'bob', 'carol']);
        hold('socket-a', 'alice', 'bob');
        setOnline(['bob', 'carol']);
        clock.advance(HOLD_MS);

        assert.deepEqual(passed, []);
    });

    test('without the host holding, everyone online must still agree', () => {
        setOnline(['alice', 'bob', 'carol']);
        hold('socket-b', 'bob', 'carol');
        hold('socket-c', 'carol', 'carol');
        clock.advance(HOLD_MS);

        assert.deepEqual(passed, []);
    });
});
