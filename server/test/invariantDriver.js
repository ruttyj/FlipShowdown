import { PLAYER, ROOM, ROUND_SCORE } from '../src/gameActions/roomTx.js';
import { INVARIANTS } from './invariantChecks.js';

// Seeded random driver for invariants.test.js (this file contains no tests of
// its own). Each sequence creates a room and runs random actions against it
// over HTTP, mostly well-formed and by the right person, sometimes not, and
// checks every invariant in invariantChecks.js after each step.

const STEPS_PER_SEQUENCE = 40;
const HOST_ACTOR_CHANCE = 0.9;
const MEMBER_ACTOR_CHANCE = 0.9;
const BRUTAL_ROOM_CHANCE = 0.5;
const ATTACK_CHANCE = 0.2;
const FLIP7_VALUES = ['1', '2', '3', '4', '5', '6', '7'];
const FLIP7_SUM = 28;

// --- Seeded randomness ---------------------------------------------------

/** mulberry32: a small, fast PRNG. Returns a function giving floats in [0, 1). */
export function createRandom(seed) {
    let state = seed >>> 0;
    return function next() {
        state = (state + 0x6D2B79F5) >>> 0;
        let mixed = state;
        mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}

/** An integer from `min` to `max`, both included. */
function randomInt(random, min, max) {
    return min + Math.floor(random() * (max - min + 1));
}

function pick(random, list) {
    return list[Math.floor(random() * list.length)];
}

function pickWeighted(random, entries) {
    let totalWeight = 0;
    for (const entry of entries) {
        totalWeight += entry.weight;
    }

    let roll = random() * totalWeight;
    for (const entry of entries) {
        roll -= entry.weight;
        if (roll < 0) {
            return entry;
        }
    }
    return entries[entries.length - 1];
}

// --- Actors and bodies ---------------------------------------------------

function memberUsers(users, snapshot) {
    const emails = new Set(snapshot.players.map((player) => player.email));
    return users.filter((user) => emails.has(user.email));
}

/** Usually the host, sometimes anyone (to exercise the not_host refusals). */
function pickHostActor(random, users, snapshot) {
    const host = users.find((user) => user.email === snapshot.room.host_email);
    if (host && random() < HOST_ACTOR_CHANCE) {
        return host;
    }
    return pick(random, users);
}

/** Usually a member, sometimes anyone. */
function pickMemberActor(random, users, snapshot) {
    const members = memberUsers(users, snapshot);
    if (members.length > 0 && random() < MEMBER_ACTOR_CHANCE) {
        return pick(random, members);
    }
    return pick(random, users);
}

/** Usually a current player's id, sometimes one that doesn't exist. */
function pickPlayerId(random, snapshot) {
    if (snapshot.players.length === 0 || random() < 0.05) {
        return 'no-such-player';
    }
    return pick(random, snapshot.players).id;
}

/**
 * Mostly small valid scores, so games reach max_score; some negative (X1
 * allows them once W1.2 lands) and some above the allowed range.
 */
function randomScoreValue(random) {
    const roll = random();
    if (roll < 0.85) {
        return randomInt(random, 0, 25);
    }
    if (roll < 0.95) {
        return randomInt(random, -10, -1);
    }
    return randomInt(random, 1001, 1500);
}

/** A Flip 7 taking 15 from someone: refused outside Brutal, or when it names its own player. */
function attackScoreFields(random, snapshot) {
    return {
        cards: FLIP7_VALUES.map((value) => ({ value, type: 'number' })),
        base_sum: FLIP7_SUM,
        final_score: FLIP7_SUM,
        flip7_attack_player_id: pickPlayerId(random, snapshot),
    };
}

function randomScoreFields(random, snapshot) {
    if (random() < ATTACK_CHANCE) {
        return attackScoreFields(random, snapshot);
    }

    const value = randomScoreValue(random);
    return { cards: [{ value: String(value), type: 'number' }], base_sum: value, final_score: value };
}

/** Usually the current round, sometimes the one before or after it. */
function pickRoundNumber(random, snapshot) {
    const current = snapshot.room.current_round;
    const roll = random();
    if (roll < 0.85) {
        return current;
    }
    if (roll < 0.95) {
        return Math.max(1, current - 1);
    }
    return current + 1;
}

// --- Moves ---------------------------------------------------------------

function buildJoin(random, users, snapshot) {
    const members = memberUsers(users, snapshot);
    const outsiders = users.filter((user) => !members.includes(user));
    let actor = pick(random, users);
    if (outsiders.length > 0 && random() < 0.8) {
        actor = pick(random, outsiders);
    }
    return { actor, body: { name: actor.name } };
}

function buildLeave(random, users, snapshot) {
    return { actor: pickMemberActor(random, users, snapshot), body: {} };
}

function buildPlayerTarget(random, users, snapshot) {
    return { actor: pickHostActor(random, users, snapshot), body: { player_id: pickPlayerId(random, snapshot) } };
}

function buildHostOnly(random, users, snapshot) {
    return { actor: pickHostActor(random, users, snapshot), body: {} };
}

function buildSubmit(random, users, snapshot) {
    const body = { round_number: pickRoundNumber(random, snapshot), ...randomScoreFields(random, snapshot) };
    return { actor: pickMemberActor(random, users, snapshot), body };
}

function buildRetract(random, users, snapshot) {
    return { actor: pickMemberActor(random, users, snapshot), body: { round_number: pickRoundNumber(random, snapshot) } };
}

function buildForce(random, users, snapshot) {
    return { actor: pickHostActor(random, users, snapshot), body: { round_number: pickRoundNumber(random, snapshot) } };
}

function buildEditScore(random, users, snapshot) {
    const body = {
        player_id: pickPlayerId(random, snapshot),
        round_number: randomInt(random, 1, snapshot.room.current_round),
        ...randomScoreFields(random, snapshot),
    };
    return { actor: pickHostActor(random, users, snapshot), body };
}

function buildSetEditMode(random, users, snapshot) {
    return { actor: pickHostActor(random, users, snapshot), body: { on: random() < 0.5 } };
}

/** The actions B7 lists, plus `start` so games begin. */
export const MOVES = [
    { name: 'join', weight: 3, build: buildJoin },
    { name: 'leave', weight: 1, build: buildLeave },
    { name: 'kick', weight: 1, build: buildPlayerTarget },
    { name: 'start', weight: 2, build: buildHostOnly },
    { name: 'submit-score', weight: 10, build: buildSubmit },
    { name: 'retract-score', weight: 2, build: buildRetract },
    { name: 'force-next-round', weight: 1.5, build: buildForce },
    { name: 'edit-score', weight: 2, build: buildEditScore },
    { name: 'set-edit-mode', weight: 1.5, build: buildSetEditMode },
    { name: 'make-host', weight: 1, build: buildPlayerTarget },
    { name: 'end-game', weight: 0.5, build: buildHostOnly },
    { name: 'reopen-game', weight: 0.5, build: buildHostOnly },
    { name: 'play-again', weight: 1.5, build: buildHostOnly },
];

// --- Reading state -------------------------------------------------------

function byTurnOrder(left, right) {
    return left.turn_order - right.turn_order;
}

function readSnapshot(store, roomId) {
    return {
        room: store.getRecord(ROOM, roomId),
        players: store.findRecords(PLAYER, 'room_id', roomId).sort(byTurnOrder),
        scores: store.findRecords(ROUND_SCORE, 'room_id', roomId),
    };
}

function readNewEvents(store, afterSeq) {
    const rows = store.eventLog.readAfter(afterSeq, null);
    return rows.map((row) => ({ seq: row.seq, roomVersion: JSON.parse(row.text).room_version }));
}

// --- Running and checking ------------------------------------------------

function describeResponse(response) {
    const code = response.body?.code;
    if (code) {
        return `${response.status} ${code}`;
    }
    return String(response.status);
}

function formatFailure(seed, trace, message) {
    return [
        `${message}`,
        `seed ${seed} (rerun: INVARIANT_SEED=${seed} INVARIANT_RUNS=1)`,
        'trace:',
        ...trace.map((line) => `  ${line}`),
    ].join('\n');
}

/** Runs every invariant on `step`, keeping the first failure of each. */
function checkStep(report, step, sequence) {
    for (const invariant of INVARIANTS) {
        if (report.failures.has(invariant.id)) {
            continue;
        }
        const message = invariant.check(step);
        if (message) {
            report.failures.set(invariant.id, formatFailure(sequence.seed, sequence.trace, message));
        }
    }
}

/**
 * Applies one response: snapshots the room, reads the new events, checks
 * every invariant and records coverage. Returns the new snapshot.
 */
function recordStep(report, sequence, action, response, before) {
    const store = report.server.instance.store;
    const lastSeq = report.lastSeq;
    const events = readNewEvents(store, lastSeq);
    const after = readSnapshot(store, sequence.roomId);
    if (events.length > 0) {
        report.lastSeq = events[events.length - 1].seq;
    }

    checkStep(report, { action, status: response.status, before, after, events, lastSeq }, sequence);
    if (response.status === 200) {
        report.committedActions.add(action);
    }
    report.statusesSeen.add(after.room.status);
    return after;
}

async function createSequenceRoom(report, sequence, random) {
    const creator = pick(random, report.users);
    const maxScore = randomInt(random, 20, 80);
    const gameMode = random() < BRUTAL_ROOM_CHANCE ? 'brutal' : 'classic';
    const response = await creator.createRoom({ max_score: maxScore, name: creator.name, game_mode: gameMode });
    if (response.status !== 200) {
        throw new Error(`Creating a room failed with ${response.status}`);
    }

    sequence.roomId = response.body.room.id;
    sequence.trace.push(`0. ${creator.name} create {"max_score":${maxScore},"game_mode":"${gameMode}"} -> 200`);
    return recordStep(report, sequence, 'create', response, null);
}

async function runSequence(report, seed) {
    const random = createRandom(seed);
    const sequence = { seed, roomId: null, trace: [] };
    let snapshot = await createSequenceRoom(report, sequence, random);

    for (let index = 1; index <= STEPS_PER_SEQUENCE; index++) {
        if (snapshot.room.status === 'closed') {
            break;
        }

        const move = pickWeighted(random, MOVES);
        const { actor, body } = move.build(random, report.users, snapshot);
        const response = await actor.action(sequence.roomId, move.name, body);
        sequence.trace.push(`${index}. ${actor.name} ${move.name} ${JSON.stringify(body)} -> ${describeResponse(response)}`);

        snapshot = recordStep(report, sequence, move.name, response, snapshot);
    }
}

/**
 * Runs `runs` sequences with seeds baseSeed, baseSeed + 1, ... against
 * `server` (from startTestServer), acting as `users` (TestPlayers).
 * Returns { failures: Map(invariant id -> message with seed and trace),
 * committedActions: Set, statusesSeen: Set }.
 */
export async function runSequences({ server, users, baseSeed, runs }) {
    const report = {
        server,
        users,
        lastSeq: server.instance.store.eventLog.lastSeq,
        failures: new Map(),
        committedActions: new Set(),
        statusesSeen: new Set(),
    };

    for (let index = 0; index < runs; index++) {
        await runSequence(report, baseSeed + index);
    }
    return report;
}
