import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createVoteTopics } from '../../src/actions/VoteTopics.js';

// The hold-to-vote topics with a recording runner. The vote flow itself is covered over the socket
// in votesRealtime.test.

const MAKE_HOST_ACTION = { name: 'make-host' };

function createRecordingRunner(result) {
    const calls = [];
    return {
        calls,
        runAsSystem(handler, roomId, body) {
            calls.push({ handler, roomId, body });
            return result;
        },
    };
}

describe('vote topics', () => {
    const room = { id: 'r1', status: 'playing', host_player_id: 'p1', host_email: 'host@example.com' };
    const players = [
        { id: 'p1', email: 'host@example.com' },
        { id: 'p2', email: 'guest@example.com' },
    ];

    function makeHostTopic(runner = createRecordingRunner()) {
        return createVoteTopics({ runner, makeHostAction: MAKE_HOST_ACTION })['make-host'];
    }

    test('make-host is the only topic, and the host may decide it alone', () => {
        const topics = createVoteTopics({ runner: createRecordingRunner(), makeHostAction: MAKE_HOST_ACTION });

        assert.deepEqual(Object.keys(topics), ['make-host']);
        assert.equal(topics['make-host'].hostDecides, true);
    });

    test('make-host accepts a player in a live room who isn\'t the host', () => {
        const topic = makeHostTopic();

        assert.equal(topic.validateOption(room, players, 'p2'), true);
        assert.equal(topic.validateOption(room, players, 'p1'), false, 'the host by host_player_id');
        assert.equal(topic.validateOption({ ...room, host_player_id: null }, players, 'p1'), false, 'the host by email');
        assert.equal(topic.validateOption(room, players, 'p3'), false, 'not in the room');
        assert.equal(topic.validateOption(null, players, 'p2'), false, 'no room');
        assert.equal(topic.validateOption({ ...room, status: 'closed' }, players, 'p2'), false, 'a closed room');
    });

    test('make-host resolves by running the make-host action as the server', () => {
        const result = { status: 200, body: {} };
        const runner = createRecordingRunner(result);

        const resolved = makeHostTopic(runner).resolve('r1', 'p2');

        assert.equal(resolved, result);
        assert.deepEqual(runner.calls, [{ handler: MAKE_HOST_ACTION, roomId: 'r1', body: { player_id: 'p2' } }]);
    });
});
