import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { INVARIANTS } from './invariantChecks.js';
import { MOVES, runSequences } from './invariantDriver.js';
import { TestPlayer, startTestServer } from './helpers.js';

// B7: a seeded random driver runs sequences of game actions against an
// in-process server and checks every invariant after every step (see
// invariantDriver.js and invariantChecks.js). A failure prints the seed and
// the action trace of the first sequence that broke that invariant.
//
//   INVARIANT_RUNS=2000 node --test server/test/invariants.test.js   more sequences
//   INVARIANT_SEED=123 INVARIANT_RUNS=1 node --test ...               replay one sequence

const DEFAULT_RUNS = 200;
const DEFAULT_SEED = 20261027;
const USER_NAMES = ['ann', 'ben', 'cat', 'dan', 'eve'];

/** Invariant id -> skip reason. */
const SKIPPED_INVARIANTS = {};

function readNonNegativeInteger(text, fallback) {
    if (text === undefined || text === '') {
        return fallback;
    }

    const value = Number(text);
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Expected a non-negative integer, got ${text}`);
    }
    return value;
}

describe('game invariants under random actions', () => {
    let server;
    let report;

    before(async () => {
        server = await startTestServer();
        const users = [];
        for (const name of USER_NAMES) {
            users.push(await TestPlayer.login(server, name));
        }

        report = await runSequences({
            server,
            users,
            baseSeed: readNonNegativeInteger(process.env.INVARIANT_SEED, DEFAULT_SEED),
            runs: readNonNegativeInteger(process.env.INVARIANT_RUNS, DEFAULT_RUNS),
        });
    });

    after(async () => {
        await server.stop();
    });

    for (const invariant of INVARIANTS) {
        const skip = SKIPPED_INVARIANTS[invariant.id] ?? false;
        test(invariant.title, { skip }, () => {
            const failure = report.failures.get(invariant.id);
            if (failure) {
                assert.fail(failure);
            }
        });
    }

    test('replaying the event log from empty rebuilds the same room state', {
        skip: 'struck: the server has no replay or rebuild code; it only re-sends stored events',
    }, () => {});

    // Guards against vacuous passes: a driver that never got a game going
    // would satisfy every invariant above.
    test('the driver commits every kind of action and reaches every room status', (t) => {
        if (process.env.INVARIANT_RUNS !== undefined) {
            t.skip('coverage is only meaningful for the default run');
            return;
        }
        for (const move of MOVES) {
            assert.ok(report.committedActions.has(move.name), `${move.name} never succeeded`);
        }
        for (const status of ['waiting', 'playing', 'finished', 'closed']) {
            assert.ok(report.statusesSeen.has(status), `no room reached ${status}`);
        }
    });
});
