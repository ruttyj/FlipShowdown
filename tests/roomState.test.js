// Tests for the pure room state reducer. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    applyEvent,
    applyPresence,
    applySnapshot,
    createRoomState,
    markRoomGone,
    selectIsEditMode,
    selectIsHost,
    selectMyPlayer,
    selectScoresByRound,
    selectSortedPlayers,
} from '../src/lib/roomState.js';

// --- Fixtures ----------------------------------------------------------------

const ROOM_ID = 'room1';

function makeRoom(overrides = {}) {
    return { id: ROOM_ID, code: 'ABC234', status: 'playing', current_round: 1, version: 1, ...overrides };
}

function makePlayer(id, overrides = {}) {
    return { id, room_id: ROOM_ID, name: id, turn_order: 0, total_score: 0, is_host: false, ...overrides };
}

function makeScore(id, overrides = {}) {
    return { id, room_id: ROOM_ID, player_id: 'p1', round_number: 1, final_score: 10, ...overrides };
}

function makeChat(id, overrides = {}) {
    return { id, room_id: ROOM_ID, sender_id: 'p2', recipient_id: 'p1', emoji: '🎉', ...overrides };
}

/** A loaded room with me (p1, host) and p2. */
function loadedState(overrides = {}) {
    return applySnapshot(createRoomState(), {
        room: makeRoom(),
        players: [makePlayer('p1', { is_host: true, turn_order: 1 }), makePlayer('p2', { turn_order: 0 })],
        roundScores: [],
        chatMessages: [],
        myPlayerId: 'p1',
        ...overrides,
    });
}

function event(type, data) {
    return { type, id: data.id, data, timestamp: '2026-01-01T00:00:00.000Z' };
}

// --- Snapshots ---------------------------------------------------------------

test('a snapshot loads everything together', () => {
    const state = loadedState({ roundScores: [makeScore('s1')], chatMessages: [makeChat('c1')] });

    assert.equal(state.room.id, ROOM_ID);
    assert.deepEqual(Object.keys(state.players).sort(), ['p1', 'p2']);
    assert.ok(state.roundScores.s1);
    assert.ok(state.chatMessages.c1);
    assert.equal(state.roomVersion, 1);
    assert.equal(selectMyPlayer(state).id, 'p1');
});

test('a snapshot older than the applied room_version keeps the newer room', () => {
    let state = loadedState();
    state = applyEvent(state, 'GameRoom', event('update', makeRoom({ current_round: 3, version: 5 })), { roomVersion: 5 });

    const stale = applySnapshot(state, {
        room: makeRoom({ current_round: 2, version: 4 }),
        players: [makePlayer('p1', { is_host: true }), makePlayer('p2')],
        myPlayerId: 'p1',
    });

    assert.equal(stale.room.current_round, 3);
    assert.equal(stale.roomVersion, 5);
});

test('a stale room in a snapshot never overwrites a higher-version local room', () => {
    // The local room came from an earlier snapshot at version 6, not from an event.
    const state = loadedState({ room: makeRoom({ current_round: 4, version: 6 }) });

    const stale = applySnapshot(state, { room: makeRoom({ current_round: 3, version: 5 }), players: [], myPlayerId: 'p1' });

    assert.equal(stale.room.current_round, 4);
});

test('a stale snapshot still brings back records missed while offline', () => {
    let state = loadedState({ chatMessages: [makeChat('gone')] });
    // A live event at version 7 arrived before the snapshot (taken at version 6) came back.
    state = applyEvent(state, 'Player', event('update', makePlayer('p2', { total_score: 70 })), { roomVersion: 7 });

    const next = applySnapshot(state, {
        room: makeRoom({ version: 6 }),
        players: [makePlayer('p1', { is_host: true }), makePlayer('p2', { total_score: 60 }), makePlayer('p3')],
        roundScores: [makeScore('missed')],
        chatMessages: [],
        myPlayerId: 'p1',
        sinceEvent: 0,
    });

    // Newer than the snapshot: kept.
    assert.equal(next.players.p2.total_score, 70);
    // Missed while offline: added, and the deleted chat message is removed.
    assert.ok(next.players.p3);
    assert.ok(next.roundScores.missed);
    assert.equal(next.chatMessages.gone, undefined);
    assert.equal(next.roomVersion, 7);
});

test('a stale snapshot keeps records created or deleted by newer events', () => {
    let state = loadedState();
    state = applyEvent(state, 'RoundScore', event('create', makeScore('fresh')), { roomVersion: 8 });
    state = applyEvent(state, 'Player', event('delete', makePlayer('p2')), { roomVersion: 8 });

    const next = applySnapshot(state, {
        room: makeRoom({ version: 7 }),
        players: [makePlayer('p1', { is_host: true }), makePlayer('p2')],
        roundScores: [],
        myPlayerId: 'p1',
        sinceEvent: 0,
    });

    assert.ok(next.roundScores.fresh);
    assert.equal(next.players.p2, undefined);
});

test('a snapshot at or above an event version replaces it, even if the event came during the fetch', () => {
    let state = loadedState();
    const sinceEvent = state.eventIndex;
    state = applyEvent(state, 'Player', event('update', makePlayer('p2', { total_score: 5 })), { roomVersion: 3 });

    const next = applySnapshot(state, {
        room: makeRoom({ version: 3 }),
        players: [makePlayer('p1', { is_host: true }), makePlayer('p2', { total_score: 9 })],
        myPlayerId: 'p1',
        sinceEvent,
    });

    assert.equal(next.players.p2.total_score, 9);
});

test('a stale snapshot naming my Player does not undo a newer delete of it', () => {
    let state = loadedState();
    state = applyEvent(state, 'Player', event('delete', makePlayer('p1')), { roomVersion: 4 });

    const next = applySnapshot(state, {
        room: makeRoom({ version: 3 }),
        players: [makePlayer('p1', { is_host: true }), makePlayer('p2')],
        myPlayerId: 'p1',
        sinceEvent: 0,
    });

    assert.equal(selectMyPlayer(next), null);
    assert.equal(next.removedFromRoom, true);
});

test('a snapshot at the same or a newer version is applied', () => {
    const state = loadedState();
    const next = applySnapshot(state, {
        room: makeRoom({ current_round: 2, version: 2 }),
        players: [makePlayer('p1', { is_host: true })],
        myPlayerId: 'p1',
    });

    assert.equal(next.room.current_round, 2);
    assert.equal(next.roomVersion, 2);
    assert.deepEqual(Object.keys(next.players), ['p1']);
});

// --- Create / update / delete per entity -------------------------------------

test('GameRoom update replaces the room', () => {
    const state = applyEvent(loadedState(), 'GameRoom', event('update', makeRoom({ current_round: 2 })));
    assert.equal(state.room.current_round, 2);
});

test('GameRoom events for another room are ignored', () => {
    const state = loadedState();
    const next = applyEvent(state, 'GameRoom', event('update', { ...makeRoom(), id: 'other' }));
    assert.equal(next, state);
});

for (const [entity, collection, make] of [
    ['Player', 'players', (id, extra) => makePlayer(id, extra)],
    ['RoundScore', 'roundScores', (id, extra) => makeScore(id, extra)],
    ['ChatMessage', 'chatMessages', (id, extra) => makeChat(id, extra)],
]) {
    test(`${entity} create, update and delete`, () => {
        let state = loadedState();

        state = applyEvent(state, entity, event('create', make('x1', { name: 'one' })));
        assert.equal(state[collection].x1.name, 'one');

        state = applyEvent(state, entity, event('update', make('x1', { name: 'two' })));
        assert.equal(state[collection].x1.name, 'two');

        state = applyEvent(state, entity, event('delete', make('x1', { name: 'two' })));
        assert.equal(state[collection].x1, undefined);
    });

    test(`${entity} events for another room are ignored`, () => {
        const state = loadedState();
        const next = applyEvent(state, entity, event('create', make('x1', { room_id: 'other' })));
        assert.equal(next, state);
    });
}

test('events before the room has loaded are ignored', () => {
    const state = createRoomState();
    const next = applyEvent(state, 'Player', event('create', makePlayer('p1')));
    assert.equal(next, state);
});

// --- Ordering ----------------------------------------------------------------

test('an event with an older room_version than applied is dropped', () => {
    let state = loadedState();
    state = applyEvent(state, 'Player', event('update', makePlayer('p2', { total_score: 50 })), { roomVersion: 6 });

    const late = applyEvent(state, 'Player', event('update', makePlayer('p2', { total_score: 20 })), { roomVersion: 5 });

    assert.equal(late, state);
    assert.equal(late.players.p2.total_score, 50);
});

test('events in the same action (same room_version) all apply', () => {
    let state = loadedState();
    state = applyEvent(state, 'Player', event('update', makePlayer('p1', { total_score: 5 })), { roomVersion: 3 });
    state = applyEvent(state, 'Player', event('update', makePlayer('p2', { total_score: 7 })), { roomVersion: 3 });

    assert.equal(state.players.p1.total_score, 5);
    assert.equal(state.players.p2.total_score, 7);
});

test('a refetch requested before an event does not undo it (unversioned writes)', () => {
    let state = loadedState();
    const sinceEvent = state.eventIndex;

    // While the refetch is in flight: p2 scores, p3 joins and a score is deleted.
    state = applyEvent(state, 'RoundScore', event('create', makeScore('s1')));
    state = applyEvent(state, 'Player', event('update', makePlayer('p2', { total_score: 10 })));
    state = applyEvent(state, 'Player', event('create', makePlayer('p3')));
    state = applyEvent(state, 'RoundScore', event('delete', makeScore('s1')));

    // The response reflects the server before those writes.
    const next = applySnapshot(state, {
        room: makeRoom(),
        players: [makePlayer('p1', { is_host: true }), makePlayer('p2', { total_score: 0 })],
        roundScores: [makeScore('s1')],
        myPlayerId: 'p1',
        sinceEvent,
    });

    assert.equal(next.players.p2.total_score, 10);
    assert.ok(next.players.p3);
    assert.equal(next.roundScores.s1, undefined);
});

test('a refetch requested after an event replaces it', () => {
    let state = loadedState();
    state = applyEvent(state, 'Player', event('update', makePlayer('p2', { total_score: 10 })));

    const next = applySnapshot(state, {
        room: makeRoom(),
        players: [makePlayer('p1', { is_host: true }), makePlayer('p2', { total_score: 12 })],
        myPlayerId: 'p1',
        sinceEvent: state.eventIndex,
    });

    assert.equal(next.players.p2.total_score, 12);
});

// --- Kicked ------------------------------------------------------------------

test('my Player deleted while the room is open sets removedFromRoom', () => {
    const state = applyEvent(loadedState(), 'Player', event('delete', makePlayer('p1', { is_host: true })));

    assert.equal(state.removedFromRoom, true);
    assert.equal(state.roomGone, false);
    assert.equal(selectMyPlayer(state), null);
});

test('another player deleted does not set removedFromRoom', () => {
    const state = applyEvent(loadedState(), 'Player', event('delete', makePlayer('p2')));
    assert.equal(state.removedFromRoom, false);
});

test('removedFromRoom survives a refetch where I am not a member', () => {
    let state = applyEvent(loadedState(), 'Player', event('delete', makePlayer('p1')));
    state = applySnapshot(state, { room: makeRoom(), players: [makePlayer('p2')], myPlayerId: null });
    assert.equal(state.removedFromRoom, true);
});

test('a refetch that no longer contains my Player sets removedFromRoom', () => {
    const state = applySnapshot(loadedState(), { room: makeRoom(), players: [makePlayer('p2')], myPlayerId: null });
    assert.equal(state.removedFromRoom, true);
});

test('rejoining clears removedFromRoom', () => {
    let state = applyEvent(loadedState(), 'Player', event('delete', makePlayer('p1')));
    state = applySnapshot(state, { room: makeRoom(), players: [makePlayer('p4')], myPlayerId: 'p4' });
    assert.equal(state.removedFromRoom, false);
    assert.equal(selectMyPlayer(state).id, 'p4');
});

// --- Room gone ---------------------------------------------------------------

test('a GameRoom delete sets roomGone and the child deletes after it are ignored', () => {
    let state = applyEvent(loadedState(), 'GameRoom', event('delete', makeRoom({ status: 'finished' })));
    assert.equal(state.roomGone, true);

    const afterRoomGone = applyEvent(state, 'Player', event('delete', makePlayer('p1')));
    assert.equal(afterRoomGone, state);
    assert.equal(afterRoomGone.removedFromRoom, false);
});

test('status closed sets roomGone and the deletes that follow are ignored', () => {
    let state = applyEvent(loadedState(), 'GameRoom', event('update', makeRoom({ status: 'closed' })), { roomVersion: 2 });
    assert.equal(state.roomGone, true);

    state = applyEvent(state, 'RoundScore', event('delete', makeScore('s1')), { roomVersion: 2 });
    state = applyEvent(state, 'Player', event('delete', makePlayer('p1')), { roomVersion: 2 });
    state = applyEvent(state, 'GameRoom', event('delete', makeRoom({ status: 'closed' })), { roomVersion: 2 });

    assert.equal(state.removedFromRoom, false);
    assert.ok(state.players.p1);
});

test('a closed room in a snapshot sets roomGone', () => {
    const state = applySnapshot(loadedState(), { room: makeRoom({ status: 'closed' }), players: [], myPlayerId: null });
    assert.equal(state.roomGone, true);
    assert.equal(state.removedFromRoom, false);
});

test('a snapshot after the room is gone is ignored', () => {
    const state = markRoomGone(loadedState());
    const next = applySnapshot(state, { room: makeRoom({ version: 9 }), players: [], myPlayerId: 'p1' });
    assert.equal(next, state);
});

test('markRoomGone (room not found on refetch) sets roomGone', () => {
    const state = markRoomGone(loadedState());
    assert.equal(state.roomGone, true);
});

test('my Player deleted just before the room delete is not "removed"', () => {
    let state = applyEvent(loadedState(), 'Player', event('delete', makePlayer('p1')), { roomVersion: 2 });
    assert.equal(state.removedFromRoom, true);

    state = applyEvent(state, 'GameRoom', event('delete', makeRoom()), { roomVersion: 2 });
    assert.equal(state.roomGone, true);
    assert.equal(state.removedFromRoom, false);
});

test('my Player deleted just before the room closes is not "removed"', () => {
    let state = applyEvent(loadedState(), 'Player', event('delete', makePlayer('p1')), { roomVersion: 2 });
    state = applyEvent(state, 'GameRoom', event('update', makeRoom({ status: 'closed' })), { roomVersion: 2 });
    assert.equal(state.removedFromRoom, false);
});

test('markRoomGone after my Player was deleted clears removedFromRoom', () => {
    let state = applyEvent(loadedState(), 'Player', event('delete', makePlayer('p1')));
    state = markRoomGone(state);
    assert.equal(state.removedFromRoom, false);
});

// --- Presence ----------------------------------------------------------------

test('presence merges per player', () => {
    let state = loadedState();
    state = applyPresence(state, ROOM_ID, [
        { playerId: 'p1', online: true, lastSeen: null },
        { playerId: 'p2', online: true, lastSeen: null },
    ]);
    state = applyPresence(state, ROOM_ID, [{ playerId: 'p2', online: false, lastSeen: '2026-01-01T10:00:00.000Z' }]);

    const players = selectSortedPlayers(state);
    const byId = Object.fromEntries(players.map(player => [player.id, player]));
    assert.equal(byId.p1.online, true);
    assert.equal(byId.p2.online, false);
    assert.equal(byId.p2.last_seen, '2026-01-01T10:00:00.000Z');
});

test('presence for another room is ignored', () => {
    const state = loadedState();
    const next = applyPresence(state, 'other', [{ playerId: 'p1', online: true }]);
    assert.equal(next, state);
});

test('presence survives a refetch', () => {
    let state = applyPresence(loadedState(), ROOM_ID, [{ playerId: 'p2', online: true }]);
    state = applySnapshot(state, { room: makeRoom(), players: [makePlayer('p1'), makePlayer('p2')], myPlayerId: 'p1' });
    assert.equal(selectSortedPlayers(state).find(player => player.id === 'p2').online, true);
});

// --- Selectors ---------------------------------------------------------------

test('selectors: sorted players, host, edit mode and scores by round', () => {
    let state = loadedState({
        roundScores: [
            makeScore('s2', { round_number: 2 }),
            makeScore('s1', { round_number: 1 }),
            makeScore('s3', { round_number: 1, player_id: 'p2' }),
        ],
    });

    assert.deepEqual(selectSortedPlayers(state).map(player => player.id), ['p2', 'p1']);
    assert.equal(selectIsHost(state), true);
    assert.equal(selectIsEditMode(state), false);

    const byRound = selectScoresByRound(state);
    assert.deepEqual(byRound[1].map(score => score.id), ['s1', 's3']);
    assert.deepEqual(byRound[2].map(score => score.id), ['s2']);

    state = applyEvent(state, 'GameRoom', event('update', makeRoom({ is_edit_mode: true })));
    assert.equal(selectIsEditMode(state), true);
});
