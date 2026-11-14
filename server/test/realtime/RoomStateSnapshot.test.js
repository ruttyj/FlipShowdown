import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RoomStateSnapshot } from '../../src/realtime/RoomStateSnapshot.js';
import { createRecordingParts } from './recordingParts.js';

test('RoomStateSnapshot sends presence, votes and entries room by room', () => {
    const { calls, parts } = createRecordingParts();
    const socket = {};

    new RoomStateSnapshot(parts).send(socket, new Set(['r1', 'r2']));

    assert.deepEqual(calls, [
        ['presence.sendState', socket, 'r1'],
        ['votes.sendStates', socket, 'r1'],
        ['entries.sendState', socket, 'r1'],
        ['presence.sendState', socket, 'r2'],
        ['votes.sendStates', socket, 'r2'],
        ['entries.sendState', socket, 'r2'],
    ]);
});
