// Tests for the entering-cards indicator helpers.
// Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enteringMessage, isNextDealerHighlighted, selectEnteringPlayers } from '../src/lib/entryStatus.js';

const PLAYERS = [
    { id: 'p1', name: 'Me' },
    { id: 'p2', name: 'Sam' },
    { id: 'p3', name: 'Jo' },
    { id: 'p4', name: 'Kim' },
];

function entry(playerId, state, round = 1) {
    return { playerId, state, round };
}

function select(entries, overrides = {}) {
    return selectEnteringPlayers({
        entries,
        players: PLAYERS,
        currentPlayerId: 'p1',
        round: 1,
        ...overrides,
    });
}

// --- selectEnteringPlayers ---------------------------------------------------------

test('no entries means nobody is entering', () => {
    assert.deepEqual(select([]), []);
});

test('an entry becomes the player with their name and state', () => {
    assert.deepEqual(select([entry('p2', 'scanning')]), [{ id: 'p2', name: 'Sam', state: 'scanning' }]);
});

test('my own entry is left out', () => {
    assert.deepEqual(select([entry('p1', 'typing')]), []);
});

test('an entry for another round is left out', () => {
    assert.deepEqual(select([entry('p2', 'typing', 1), entry('p3', 'typing', 2)]), [
        { id: 'p2', name: 'Sam', state: 'typing' },
    ]);
});

test('an entry for a player who is not in the room is left out', () => {
    assert.deepEqual(select([entry('ghost', 'typing')]), []);
});

test('entering players follow the players list order, not the order of arrival', () => {
    const result = select([entry('p4', 'typing'), entry('p2', 'scanning'), entry('p3', 'typing')]);

    assert.deepEqual(result.map((player) => player.id), ['p2', 'p3', 'p4']);
});

test('a missing entries list is treated as nobody entering', () => {
    assert.deepEqual(select(undefined), []);
});

// --- enteringMessage ---------------------------------------------------------------

test('nobody entering has no message', () => {
    assert.equal(enteringMessage([]), null);
});

test('one person scanning', () => {
    assert.equal(
        enteringMessage([{ id: 'p2', name: 'Sam', state: 'scanning' }]),
        'Hold on, Sam is scanning cards',
    );
});

test('one person typing', () => {
    assert.equal(
        enteringMessage([{ id: 'p2', name: 'Sam', state: 'typing' }]),
        'Hold on, Sam is entering cards',
    );
});

test('two people are both named and share the "entering" wording, even if one is scanning', () => {
    assert.equal(
        enteringMessage([
            { id: 'p2', name: 'Sam', state: 'scanning' },
            { id: 'p3', name: 'Jo', state: 'typing' },
        ]),
        'Hold on, Sam and Jo are entering cards',
    );
});

test('three or more people are counted instead of named', () => {
    const three = [
        { id: 'p2', name: 'Sam', state: 'typing' },
        { id: 'p3', name: 'Jo', state: 'typing' },
        { id: 'p4', name: 'Kim', state: 'scanning' },
    ];

    assert.equal(enteringMessage(three), 'Hold on, 3 players are entering cards');
    assert.equal(
        enteringMessage([...three, { id: 'p5', name: 'Al', state: 'typing' }]),
        'Hold on, 4 players are entering cards',
    );
});

// --- Who the turn card points at (X48) ---------------------------------------

function nextDealerHighlighted(overrides = {}) {
    return isNextDealerHighlighted({
        room: { current_round: 2, turn_passed_round: null },
        players: [{ id: 'p1', has_submitted_round: false }, { id: 'p2', has_submitted_round: false }],
        enteringPlayers: [],
        hasEntryOpen: false,
        ...overrides,
    });
}

test('the current dealer stays highlighted before anyone has started on their cards', () => {
    assert.equal(nextDealerHighlighted(), false);
});

test('the next dealer is highlighted once another player is entering cards', () => {
    assert.equal(nextDealerHighlighted({ enteringPlayers: [{ id: 'p2', name: 'Sam', state: 'typing' }] }), true);
});

test('the next dealer is highlighted once I have score entry open', () => {
    assert.equal(nextDealerHighlighted({ hasEntryOpen: true }), true);
});

test('the next dealer is highlighted once anyone has a score in', () => {
    const players = [{ id: 'p1', has_submitted_round: false }, { id: 'p2', has_submitted_round: true }];

    assert.equal(nextDealerHighlighted({ players }), true);
});

test('the current dealer stays highlighted when a departing dealer already passed them the deal', () => {
    const players = [{ id: 'p2', has_submitted_round: true }];
    const room = { current_round: 2, turn_passed_round: 2 };

    assert.equal(nextDealerHighlighted({ room, players }), false);
});

test('a deal passed on in an earlier round does not hold the highlight back', () => {
    const players = [{ id: 'p2', has_submitted_round: true }];
    const room = { current_round: 3, turn_passed_round: 2 };

    assert.equal(nextDealerHighlighted({ room, players }), true);
});
